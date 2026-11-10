import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE } from '@line-crm/shared';
import { getMusuboTenantBilling } from '@line-crm/db';
import { createTestD1, type SqliteD1 } from '../test-utils/d1-sqlite.js';
import { musuboBillingOverview } from './musubo-billing-overview.js';

const tenantId = '00000000-0000-4000-8000-000000000001';
let fixture: SqliteD1;

beforeEach(() => {
  fixture = createTestD1();
  fixture.raw.prepare(`INSERT INTO musubo_tenant_billing
    (tenant_id,pricing_snapshot_json,pricing_selection_json,billing_interval,status,
      first_line_activated_at,trial_last_free_date,first_charge_date,created_at,updated_at)
    VALUES (?,?,?,'month','trialing',?,'2026-12-08','2026-12-09',?,?)`).run(
    tenantId,
    JSON.stringify({ sourceConditionId: 'normal', sourceVersion: 1,
      internalName: '通常条件', trialPeriod: { unit: 'days', value: 30 },
      lineBasicDiscountPercent: 0, discountEndsOn: null, schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE }),
    JSON.stringify({ selection: { lineCount: 3, friendCountExcludingBlocked: 2_800 } }),
    '2026-11-09T10:00:00+09:00', '2026-11-09T10:00:00+09:00', '2026-11-09T10:00:00+09:00',
  );
});

it('shows only connected LINE accounts, never charges the planned three accounts', async () => {
  fixture.raw.prepare(`INSERT INTO line_accounts
    (id,channel_id,name,channel_access_token,channel_secret,tenant_id)
    VALUES ('line-first','channel-first','公式LINE A','token','secret',?)`).run(tenantId);
  fixture.raw.prepare(`INSERT INTO musubo_line_usage
    (line_account_id,tenant_id,status,activated_at,google_business_count,instagram_count,updated_at)
    VALUES ('line-first',?,'active',?,2,1,?)`).run(tenantId,
    '2026-11-09T10:00:00+09:00', '2026-11-09T10:00:00+09:00');
  const billing = await getMusuboTenantBilling(fixture.db, tenantId);
  const overview = await musuboBillingOverview(fixture.db, tenantId, billing!);
  expect(overview).toMatchObject({ status: 'trialing', activeLines: [{ id: 'line-first', name: '公式LINE A' }],
    trialLastFreeDate: '2026-12-08', firstChargeDate: '2026-12-09', estimatedPrice: null });
  fixture.raw.prepare('UPDATE musubo_tenant_billing SET pricing_selection_json=? WHERE tenant_id=?')
    .run(JSON.stringify({ selection: { lineCount: 1, friendCountExcludingBlocked: 2_800 } }), tenantId);
  const updated = await getMusuboTenantBilling(fixture.db, tenantId);
  expect((await musuboBillingOverview(fixture.db, tenantId, updated!)).estimatedPrice)
    .toMatchObject({ lineCount: 1, monthlyTotalYen: 9_200, linkedAccountSlots: 1 });
});

it('does not invent a charge before the first LINE is connected', async () => {
  const billing = await getMusuboTenantBilling(fixture.db, tenantId);
  const overview = await musuboBillingOverview(fixture.db, tenantId, billing!);
  expect(overview.activeLines).toEqual([]);
  expect(overview.estimatedPrice).toBeNull();
});

it('shows the accepted eleven-LINE base capacity even before all LINE accounts connect', async () => {
  fixture.raw.prepare(`INSERT INTO registration_applications
    (id,company_name,contact_name,email,phone,referral_source,status,tenant_id,created_at,updated_at)
    VALUES ('application-fixed','大手企業','担当者','quote@example.test','03-0000-0000','other',
      'activated',?,'2026-11-09','2026-11-09')`).run(tenantId);
  const quote = { quoteNumber: 'quote-fixed', companyName: '大手企業',
    issuedAt: '2026-11-09T00:00:00+09:00', expiresAt: '2026-12-09T23:59:00+09:00',
    acceptedAt: '2026-11-10T00:00:00+09:00', supersededAt: null,
    interval: 'month', plannedLineCount: 11, plannedFriendCountExcludingBlocked: 2_800,
    plannedLinkedAccountsByLine: [], trialPeriod: { unit: 'days', value: 30 },
    finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE,
      eleventhAndLaterLineYen: 6_500, friendAllowanceForElevenOrMore: 50_000 },
    finalAnnualLineChargeYen: null };
  fixture.raw.prepare(`INSERT INTO musubo_individual_quotes
    (id,application_id,tenant_id,revision,status,final_prices_json,customer_summary_json,
      expires_at,created_by,created_at,accepted_at,accepted_by)
    VALUES ('quote-fixed','application-fixed',?,1,'accepted',?,'{}',?,'ops',?,?,'owner')`)
    .run(tenantId, JSON.stringify(quote), quote.expiresAt, quote.issuedAt, quote.acceptedAt);
  fixture.raw.prepare('UPDATE musubo_tenant_billing SET quote_id=? WHERE tenant_id=?')
    .run('quote-fixed', tenantId);
  const billing = await getMusuboTenantBilling(fixture.db, tenantId);
  const overview = await musuboBillingOverview(fixture.db, tenantId, billing!);
  expect(overview.contractedCore).toEqual({ lineCapacity: 11, amountYen: 78_500, interval: 'month' });
  expect(overview.estimatedPrice).toBeNull();
});
