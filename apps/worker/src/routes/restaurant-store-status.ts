import type { Context } from 'hono';
import { getLineAccounts, type LineAccount } from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { dbFor } from '../services/db-router.js';
import { fetchWebhookEndpointState } from '../services/line-webhook-state.js';

export type RestaurantStoreRow = {
  id: string;
  organization_id: string;
  name: string;
  code: string;
  area: string | null;
  capacity: number;
  timezone: string;
  status: 'active' | 'paused' | 'archived';
  line_status: 'connected' | 'warning' | 'error' | 'unconfigured';
  google_status: string;
  line_account_id: string | null;
  line_account_name: string | null;
  friend_count?: number | null;
  reservation_token?: string | null;
  created_at: string;
  updated_at: string;
};

export function expectedWebhookUrl(c: Context<Env>): string {
  const base = (
    c.env.WORKER_PUBLIC_URL || c.env.WORKER_URL || new URL(c.req.url).origin
  ).replace(/\/$/, '');
  return `${base}/webhook`;
}

export async function deriveStoreLineStatuses(
  c: Context<Env>,
  stores: RestaurantStoreRow[],
): Promise<RestaurantStoreRow[]> {
  let accounts: LineAccount[] = [];
  try {
    accounts = await getLineAccounts(dbFor(c.env));
  } catch {
    // A credential/key failure is visible as an error status. Credential values
    // and underlying crypto errors must not be copied into this response or logs.
  }
  const byId = new Map(accounts.map((item) => [item.id, item]));
  const webhookUrl = expectedWebhookUrl(c);
  return Promise.all(stores.map(async (store) => {
    if (!store.line_account_id) {
      return { ...store, line_status: 'unconfigured' as const };
    }
    const account = byId.get(store.line_account_id);
    if (!account?.channel_access_token) {
      return { ...store, line_status: 'error' as const };
    }
    const webhook = await fetchWebhookEndpointState(account.channel_access_token, webhookUrl);
    const lineStatus: RestaurantStoreRow['line_status'] = webhook.status === 'matched'
      ? 'connected'
      : webhook.status === 'unknown'
        ? 'error'
        : 'warning';
    return { ...store, line_status: lineStatus };
  }));
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('ja-JP', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function uniqueStoreConflict(error: unknown): 'line_account' | 'code' | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/UNIQUE constraint failed/i.test(message)) return null;
  if (/rt_stores\.line_account_id/i.test(message)) return 'line_account';
  if (/rt_stores\.organization_id.*rt_stores\.code|rt_stores\.code/i.test(message)) return 'code';
  return null;
}

export function validFloorCoordinate(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 10000;
}

export function validJoinGroup(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 100);
}
