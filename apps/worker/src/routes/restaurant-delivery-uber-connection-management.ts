import { tracedFetch } from '@line-crm/shared/server';
import type { Context, Hono } from 'hono';
import type { Env } from '../worker-env.js';
import { requireRole } from '../middleware/role-guard.js';
import { auditLog } from '../lib/audit-log.js';
import { dbFor } from '../services/db-router.js';
import { deliverySendEnabled, uberOAuthClient } from '../services/restaurant-delivery.js';
import {
  checkUberConnection,
  disconnectUberConnection,
  type ConnectionMutationResult,
  type ManagedUberConnection,
} from '../features/uber-delivery/index.js';
import { fail } from './restaurant-google.js';
import type { StoreContext } from './restaurant-google.js';

export interface UberConnectionManagementDeps {
  deliveryStore(c: Context<Env>): Promise<StoreContext | null>;
  isoFromMs(value: number | null | undefined): string | null;
}

function publicConnection(row: ManagedUberConnection, isoFromMs: UberConnectionManagementDeps['isoFromMs']) {
  return {
    status: row.status,
    version: row.version,
    storeName: row.uber_store_name,
    connectedAt: isoFromMs(row.connected_at),
    provisionedAt: isoFromMs(row.provisioned_at),
    checkedAt: isoFromMs(row.updated_at),
    lastError: row.last_error,
  };
}

function failure(c: Context<Env>, result: Extract<ConnectionMutationResult, { ok: false }>) {
  const messages: Record<string, string> = {
    connection_busy: 'Uber Eats の接続確認を処理中です。少し待ってからもう一度お試しください',
    connection_changed: '接続情報が変わりました。画面を読み直してください',
    connection_not_active: '確認できる Uber Eats 接続がありません',
    confirmation_required: '確認画面から連携解除を実行してください',
    reauthorization_required: '連携解除には Uber Eats への再ログインが必要です',
    provider_ownership_unverified: 'Uber Eats 側の接続先を確認できませんでした',
    connection_review_required: 'Uber Eats の接続内容を確認する必要があります',
    connection_check_required: 'Uber Eats の接続確認を実行してください',
    order_dispatch_in_progress: 'Uber Eats の注文操作を処理中です。完了してからもう一度お試しください',
    pos_deactivation_unknown: '連携解除の結果を確認する必要があります。送り直さず musubo へお知らせください',
  };
  return fail(c, result.status, messages[result.code] ?? 'Uber Eats の接続状態を確認できませんでした', {
    code: result.code,
  });
}

/** 事業者への明示確認と、一度限りの接続解除の入口を登録する。 */
export function registerUberConnectionManagementRoutes(
  app: Hono<Env>,
  deps: UberConnectionManagementDeps,
): void {
  const settings = async (c: Context<Env>) => {
    if (!deliverySendEnabled(c.env)) {
      return fail(c, 503, 'デリバリー連携の送信がこの環境で無効です', { code: 'delivery_send_disabled' });
    }
    const client = uberOAuthClient(c.env);
    const encryptionKey = c.env.LINE_CREDENTIAL_ENCRYPTION_KEY;
    if (!client || !encryptionKey) {
      return fail(c, 503, 'Uber Eats 接続の設定がこの環境にありません', { code: 'oauth_not_configured' });
    }
    const store = await deps.deliveryStore(c);
    if (!store?.lineAccountId) return fail(c, 404, 'このLINEアカウントに店舗が紐付いていません');
    return { client, encryptionKey, store };
  };

  app.post('/api/restaurant-test/delivery/ubereats/connection/check', requireRole('owner', 'admin'), async (c) => {
    const resolved = await settings(c);
    if (resolved instanceof Response) return resolved;
    const result = await checkUberConnection({
      db: dbFor(c.env, resolved.store.id), storeId: resolved.store.id,
      accountId: resolved.store.lineAccountId!, client: resolved.client, encryptionKey: resolved.encryptionKey,
      fetcher: (url, init) => tracedFetch(url, init),
    });
    if (!result.ok) return failure(c, result);
    auditLog(c, 'restaurant.delivery.ubereats.connection.check', { id: resolved.store.id, kind: 'rt_store' });
    return c.json({ success: true, connection: publicConnection(result.connection, deps.isoFromMs) });
  });

  app.delete('/api/restaurant-test/delivery/ubereats/connection', requireRole('owner', 'admin'), async (c) => {
    const body = await c.req.json<{ confirmed?: unknown; expectedVersion?: unknown }>().catch(() => null);
    if (body?.confirmed !== true) {
      return fail(c, 400, '確認画面から連携解除を実行してください', { code: 'confirmation_required' });
    }
    if (body.expectedVersion !== undefined && (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1)) {
      return fail(c, 400, '確認した接続の版が不正です', { code: 'invalid_version' });
    }
    const resolved = await settings(c);
    if (resolved instanceof Response) return resolved;
    const result = await disconnectUberConnection({
      db: dbFor(c.env, resolved.store.id), storeId: resolved.store.id,
      accountId: resolved.store.lineAccountId!, client: resolved.client, encryptionKey: resolved.encryptionKey,
      expectedVersion: body.expectedVersion as number | undefined,
      fetcher: (url, init) => tracedFetch(url, init),
    });
    if (!result.ok && result.code === 'connection_changed') {
      const current = await dbFor(c.env, resolved.store.id).prepare(
        'SELECT * FROM rt_delivery_uber_connections WHERE store_id = ? AND account_id = ?',
      ).bind(resolved.store.id, resolved.store.lineAccountId).first<ManagedUberConnection>();
      return c.json({ success: false, code: result.code, error: '接続情報が変わりました。画面を読み直してください', connection: current ? publicConnection(current, deps.isoFromMs) : null }, 409);
    }
    if (!result.ok) return failure(c, result);
    auditLog(c, 'restaurant.delivery.ubereats.connection.disconnect', { id: resolved.store.id, kind: 'rt_store' });
    return c.json({ success: true, connection: publicConnection(result.connection, deps.isoFromMs) });
  });
}
