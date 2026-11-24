import {
  getMusuboTenantBilling,
  getVersionedAccountSetting,
  saveVersionedAccountSetting,
} from '@line-crm/db';
import {
  jstDate,
  linkedAccountSlots,
  type SetSnsGooglePrimaryResult,
  type SnsConnectionPorts,
  type SnsGoogleConnectionPort,
  type SnsSlotBilling,
} from '@line-crm/shared';
import { logger } from '@line-crm/shared/server';
import type { WorkerBindings } from '../worker-bindings.js';
import { getMusuboOptionsBillingPeriod } from './musubo-line-addition.js';
import { GOOGLE_PRIMARY_KEY, googleConnectionOrderBySql } from './google-connection-primary.js';

export const SNS_GOOGLE_PRIMARY_KEY = GOOGLE_PRIMARY_KEY;

interface PrimarySetting {
  connectionId: string;
}

interface GoogleConnectionRow {
  id: string;
  confirmation_revision: number;
  status: SnsGoogleConnectionPort['state'] | 'disconnected';
  google_account_email: string | null;
  location_name: string | null;
  location_title: string | null;
  connected_at: string | null;
}

function calendarDay(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Invalid billing date');
  const time = Date.parse(`${value}T00:00:00Z`);
  const date = new Date(time);
  if (!Number.isFinite(time) || date.getUTCFullYear() !== Number(value.slice(0, 4))
    || date.getUTCMonth() + 1 !== Number(value.slice(5, 7))
    || date.getUTCDate() !== Number(value.slice(8, 10))) {
    throw new RangeError('Invalid billing date');
  }
  return time / 86_400_000;
}

export function paidSnsSlotBilling(
  period: { start: string; end: string },
  now: Date,
): Extract<SnsSlotBilling, { kind: 'paid' }> {
  const start = calendarDay(period.start);
  const end = calendarDay(period.end);
  const today = calendarDay(jstDate(now));
  if (start > today || today >= end) throw new RangeError('Monthly billing period is unavailable');
  return { kind: 'paid', monthlyDaysRemaining: end - today, monthlyDaysInPeriod: end - start };
}

async function billingFor(
  env: WorkerBindings,
  tenantId: string,
  now: Date,
): Promise<SnsSlotBilling | null> {
  const contract = await getMusuboTenantBilling(env.DB, tenantId);
  if (contract?.status === 'trialing' && !contract.termination_requested_at) return { kind: 'trialing' };
  if (contract?.status !== 'active' || contract.termination_requested_at) return null;
  try {
    return paidSnsSlotBilling(await getMusuboOptionsBillingPeriod(env, tenantId), now);
  } catch {
    logger.warn('sns_connection_ports.billing_unavailable');
    return null;
  }
}

async function googleRows(
  db: D1Database,
  tenantId: string,
  lineAccountId: string,
): Promise<GoogleConnectionRow[]> {
  const rows = await db.prepare(
    `SELECT c.id,c.confirmation_revision,c.status,c.google_account_email,c.location_name,
            c.location_title,c.connected_at
       FROM rt_google_connections c
       JOIN rt_stores s ON s.id=c.store_id
       JOIN rt_organizations o ON o.id=s.organization_id
      WHERE s.line_account_id=? AND o.tenant_id=?
        AND c.status IN ('connected','expired','no_permission')
      ORDER BY ${googleConnectionOrderBySql('c')}`,
  ).bind(lineAccountId, tenantId, GOOGLE_PRIMARY_KEY).all<GoogleConnectionRow>();
  return rows.results;
}

function label(row: GoogleConnectionRow): string {
  return row.location_title ?? row.location_name ?? row.google_account_email ?? row.id;
}

export async function readSnsConnectionPorts(
  env: WorkerBindings,
  input: { tenantId: string; lineAccountId: string; now?: Date },
): Promise<SnsConnectionPorts | null> {
  const usage = await env.DB.prepare(
    `SELECT contracted_linked_slots
       FROM musubo_line_usage
      WHERE line_account_id=? AND tenant_id=? AND status IN ('active','ending')
      LIMIT 1`,
  ).bind(input.lineAccountId, input.tenantId).first<{ contracted_linked_slots: number }>();
  if (!usage || !Number.isSafeInteger(usage.contracted_linked_slots)
    || usage.contracted_linked_slots < 1) return null;

  const google = await googleRows(env.DB, input.tenantId, input.lineAccountId);
  const instagram = await env.DB.prepare(
    `SELECT COUNT(*) AS count
       FROM instagram_connections i
       JOIN line_accounts a ON a.id=i.line_account_id
      WHERE i.line_account_id=? AND COALESCE(a.tenant_id,?)=?`,
  ).bind(input.lineAccountId, input.tenantId, input.tenantId).first<{ count: number }>();
  const counts = { googleBusiness: google.length, instagram: Number(instagram?.count ?? 0) };
  const primary = await getVersionedAccountSetting<PrimarySetting>(
    env.DB, input.lineAccountId, SNS_GOOGLE_PRIMARY_KEY,
  );
  const selectedId = google.some((row) => row.id === primary?.data.connectionId)
    ? primary!.data.connectionId
    : google[0]?.id ?? null;

  return {
    lineAccountId: input.lineAccountId,
    contracted: usage.contracted_linked_slots,
    counts,
    linkedSlots: linkedAccountSlots(counts),
    billing: await billingFor(env, input.tenantId, input.now ?? new Date()),
    googleConnections: google.map((row) => ({
      id: row.id,
      label: label(row),
      state: row.status as SnsGoogleConnectionPort['state'],
      version: row.confirmation_revision,
      isPrimary: row.id === selectedId,
    })),
    primaryVersion: primary?.version ?? 0,
  };
}

export async function setSnsGooglePrimary(
  db: D1Database,
  input: { tenantId: string; lineAccountId: string; connectionId: string; expectedVersion: number },
): Promise<
  | { status: 'saved'; data: SetSnsGooglePrimaryResult }
  | { status: 'not_found' }
  | { status: 'conflict'; current: SetSnsGooglePrimaryResult | null }
> {
  const connection = await db.prepare(
    `SELECT c.id
       FROM rt_google_connections c
       JOIN rt_stores s ON s.id=c.store_id
       JOIN rt_organizations o ON o.id=s.organization_id
      WHERE c.id=? AND s.line_account_id=? AND o.tenant_id=?
        AND c.status IN ('connected','expired','no_permission')
      LIMIT 1`,
  ).bind(input.connectionId, input.lineAccountId, input.tenantId).first<{ id: string }>();
  if (!connection) return { status: 'not_found' };
  const saved = await saveVersionedAccountSetting(db, {
    accountId: input.lineAccountId,
    key: SNS_GOOGLE_PRIMARY_KEY,
    expectedVersion: input.expectedVersion,
    data: { connectionId: input.connectionId } satisfies PrimarySetting,
  });
  if (saved.status === 'conflict') {
    return {
      status: 'conflict',
      current: saved.current
        ? { connectionId: saved.current.data.connectionId, version: saved.current.version }
        : null,
    };
  }
  return {
    status: 'saved',
    data: { connectionId: saved.setting.data.connectionId, version: saved.setting.version },
  };
}
