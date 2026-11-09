import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { DEFAULT_MUSUBO_PRICE_SCHEDULE, type MusuboConditionDefinition } from '@line-crm/shared';
import { asD1 } from './d1-test-helper.js';
import {
  activateMusuboPricingCondition, approveRegistrationWithMusuboCondition,
  createMusuboPricingCondition,
} from '../src/musubo-pricing-conditions.js';
import {
  acceptTenantMusuboIndividualQuote, claimMusuboIndividualQuoteSend,
  createMusuboIndividualQuoteDraft, getMusuboIndividualQuote,
  markMusuboIndividualQuoteSent, musuboQuoteFromRecord,
  supersedeMusuboIndividualQuote, updateMusuboIndividualQuoteDraft,
} from '../src/musubo-individual-quotes.js';
import {
  activateFirstMusuboLine, attachAcceptedMusuboQuote, createMusuboPendingTenant,
  getMusuboTenantBilling, musuboLineConnectionAllowed, recordMusuboPricingSelection,
} from '../src/musubo-tenant-billing.js';

const migration = readFileSync(new URL('../migrations/756_musubo_pricing_onboarding.sql', import.meta.url), 'utf8');

it('starts a three-month trial only on the first LINE activation', async () => {
  const raw = new Database(':memory:');
  try {
    raw.pragma('foreign_keys=ON');
    raw.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
        plan_key TEXT, plan_status TEXT NOT NULL, trial_ends_at TEXT, plan_updated_at TEXT,
        signup_device_marker TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(id TEXT PRIMARY KEY, status TEXT NOT NULL,
        tenant_id TEXT);
    `);
    raw.exec(migration);
    const db = asD1(raw);
    const snapshot = JSON.stringify({ trialPeriod: { unit: 'months', value: 3 },
      schedule: DEFAULT_MUSUBO_PRICE_SCHEDULE });
    raw.prepare(`INSERT INTO registration_applications
      (id,status,pricing_snapshot_json) VALUES ('application-1','approved',?)`).run(snapshot);
    const tenantId = await createMusuboPendingTenant(db, {
      name: '申込会社', applicationId: 'application-1', pricingSnapshotJson: snapshot,
      deviceMarker: 'marker',
    });
    expect(raw.prepare('SELECT plan_status,trial_ends_at FROM tenants WHERE id=?').get(tenantId))
      .toEqual({ plan_status: 'exempt', trial_ends_at: null });
    expect(await musuboLineConnectionAllowed(db, tenantId)).toBe('first');
    expect(await recordMusuboPricingSelection(db, {
      tenantId, interval: 'year', selectionJson: JSON.stringify({ lineCount: 1, monthlyTotalYen: 5900 }),
    })).toBe(true);
    expect(await getMusuboTenantBilling(db, tenantId)).toMatchObject({
      billing_interval: 'year', pricing_selection_json: JSON.stringify({ lineCount: 1, monthlyTotalYen: 5900 }),
    });
    raw.prepare('INSERT INTO line_accounts(id,tenant_id) VALUES (?,?)').run('line-1', tenantId);
    const started = await activateFirstMusuboLine(db, {
      tenantId, lineAccountId: 'line-1', now: '2026-11-30T10:00:00+09:00',
    });
    expect(started).toMatchObject({ status: 'trialing',
      trial_last_free_date: '2027-02-27', first_charge_date: '2027-02-28' });
    expect(await musuboLineConnectionAllowed(db, tenantId)).toBe('requires_payment');
    raw.prepare('INSERT INTO line_accounts(id,tenant_id) VALUES (?,?)').run('line-2', tenantId);
    await expect(activateFirstMusuboLine(db, {
      tenantId, lineAccountId: 'line-2', now: '2026-12-01T10:00:00+09:00',
    })).rejects.toThrow('require payment');
    expect(raw.prepare('SELECT COUNT(*) AS n FROM musubo_line_usage').get()).toEqual({ n: 1 });
    expect((await getMusuboTenantBilling(db, tenantId))?.first_line_activated_at)
      .toBe('2026-11-30T10:00:00+09:00');
  } finally { raw.close(); }
});

it('adds pricing records without changing an existing application or tenant billing state', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    db.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY, plan_status TEXT NOT NULL);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO tenants VALUES ('tenant-1', 'active');
      INSERT INTO line_accounts VALUES ('line-1', 'tenant-1');
      INSERT INTO registration_applications VALUES ('application-1', 'approved');
    `);
    db.exec(migration);

    expect(db.prepare('SELECT status, pricing_condition_id, pricing_snapshot_json FROM registration_applications WHERE id=?')
      .get('application-1')).toEqual({ status: 'approved', pricing_condition_id: null, pricing_snapshot_json: null });
    expect(db.prepare('SELECT plan_status FROM tenants WHERE id=?').get('tenant-1')).toEqual({ plan_status: 'active' });
    expect(db.prepare('SELECT COUNT(*) AS total FROM musubo_tenant_billing').get()).toEqual({ total: 0 });

    const insertCondition = db.prepare(`INSERT INTO musubo_pricing_conditions
      (id, condition_key, version, name, status, trial_unit, trial_value,
       price_schedule_json, created_by, created_at)
      VALUES (?, 'partner', ?, 'Partner', ?, 'months', 3, '{}', 'operator', '2026-11-09')`);
    insertCondition.run('condition-1', 1, 'active');
    expect(() => insertCondition.run('condition-2', 2, 'active')).toThrow();
    insertCondition.run('condition-2', 2, 'draft');
    expect(() => db.prepare(`UPDATE musubo_pricing_conditions SET trial_value=6 WHERE id='condition-1'`).run())
      .toThrow('condition_version_immutable');
    expect(() => db.prepare(`INSERT INTO musubo_pricing_conditions
      (id, condition_key, version, name, status, trial_unit, trial_value,
       price_schedule_json, created_by, created_at)
      VALUES ('bad', 'other', 1, 'Bad', 'draft', 'days', 0, '{}', 'operator', '2026-11-09')`).run()).toThrow();
  } finally {
    db.close();
  }
});

it('copies the accepted annual quote interval into tenant billing', async () => {
  const raw = new Database(':memory:');
  try {
    raw.pragma('foreign_keys=ON');
    raw.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(id TEXT PRIMARY KEY, status TEXT NOT NULL);
      INSERT INTO tenants VALUES ('tenant-1');
      INSERT INTO registration_applications VALUES ('application-1','approved');
    `);
    raw.exec(migration);
    raw.prepare(`INSERT INTO musubo_tenant_billing
      (tenant_id,application_id,pricing_snapshot_json,billing_interval,status,created_at,updated_at)
      VALUES ('tenant-1','application-1','{}','month','awaiting_first_line','now','now')`).run();
    raw.prepare(`INSERT INTO musubo_individual_quotes
      (id,application_id,tenant_id,revision,status,final_prices_json,customer_summary_json,
       expires_at,created_by,created_at,accepted_at,accepted_by)
      VALUES ('quote-1','application-1','tenant-1',1,'accepted','{"interval":"year"}','{}',
        '2026-11-30','operator','2026-11-09','2026-11-10','owner')`).run();
    expect(await attachAcceptedMusuboQuote(asD1(raw), 'tenant-1', 'quote-1')).toBe(true);
    expect(raw.prepare('SELECT quote_id,billing_interval FROM musubo_tenant_billing WHERE tenant_id=?')
      .get('tenant-1')).toEqual({ quote_id: 'quote-1', billing_interval: 'year' });
  } finally { raw.close(); }
});

it('keeps an accepted quote available for card registration after its deadline', async () => {
  const raw = new Database(':memory:');
  try {
    raw.pragma('foreign_keys=ON');
    raw.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(
        id TEXT PRIMARY KEY, company_name TEXT NOT NULL, tenant_id TEXT, status TEXT NOT NULL);
      INSERT INTO tenants VALUES ('tenant-1');
      INSERT INTO registration_applications VALUES ('application-1','株式会社サンプル','tenant-1','activated');
    `);
    raw.exec(migration);
    const db = asD1(raw);
    const proposed = {
      expiresAt: '2026-11-12T18:00:00+09:00', interval: 'month' as const,
      plannedLineCount: 11, plannedFriendCountExcludingBlocked: 2800,
      plannedLinkedAccountsByLine: [], trialPeriod: { unit: 'months' as const, value: 3 },
      finalSchedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE, eleventhAndLaterLineYen: 6_000,
        friendAllowanceForElevenOrMore: 50_000 },
      finalAnnualLineChargeYen: null,
    };
    const draft = await createMusuboIndividualQuoteDraft(db, {
      applicationId: 'application-1', actorId: 'operator', proposed,
      now: '2026-11-10T10:00:00+09:00',
    });
    expect(draft?.revision).toBe(1);
    expect(draft?.status).toBe('draft');
    expect(await claimMusuboIndividualQuoteSend(db, draft!.id, '2026-11-10T11:00:00+09:00')).toBe(true);
    expect(await claimMusuboIndividualQuoteSend(db, draft!.id, '2026-11-10T11:01:00+09:00')).toBe(false);
    expect(await markMusuboIndividualQuoteSent(db, draft!.id, '2026-11-10T11:02:00+09:00')).toBe(true);
    expect(await updateMusuboIndividualQuoteDraft(db, {
      id: draft!.id, actorId: 'operator', proposed: musuboQuoteFromRecord(draft!),
      now: '2026-11-10T11:03:00+09:00',
    })).toBe(false);
    expect(() => raw.prepare('UPDATE musubo_individual_quotes SET expires_at=? WHERE id=?')
      .run('2026-12-31', draft!.id)).toThrow('sent_quote_terms_immutable');

    const accepted = await acceptTenantMusuboIndividualQuote(db, {
      tenantId: 'tenant-1', quoteId: draft!.id, actorId: 'owner',
      now: '2026-11-12T17:59:00+09:00',
    });
    expect(accepted?.status).toBe('accepted');
    expect(await acceptTenantMusuboIndividualQuote(db, {
      tenantId: 'tenant-1', quoteId: draft!.id, actorId: 'owner',
      now: '2026-11-12T17:59:01+09:00',
    })).toBeNull();
    expect(await supersedeMusuboIndividualQuote(db, draft!.id, '2026-11-13T10:00:00+09:00')).toBe(false);
    expect(musuboQuoteFromRecord((await getMusuboIndividualQuote(db, draft!.id))!).acceptedAt)
      .toBe('2026-11-12T17:59:00+09:00');
  } finally {
    raw.close();
  }
});

it('checks company and expiry at approval, then freezes the selected version', async () => {
  const raw = new Database(':memory:');
  try {
    raw.pragma('foreign_keys=ON');
    raw.exec(`
      CREATE TABLE tenants(id TEXT PRIMARY KEY);
      CREATE TABLE line_accounts(id TEXT PRIMARY KEY, tenant_id TEXT);
      CREATE TABLE registration_applications(
        id TEXT PRIMARY KEY, company_name TEXT NOT NULL, status TEXT NOT NULL,
        contact_note TEXT, approved_by TEXT, approved_at TEXT, updated_at TEXT);
      INSERT INTO registration_applications VALUES
        ('application-1','株式会社サンプル','contacted','確認済み',NULL,NULL,'2026-11-01');
    `);
    raw.exec(migration);
    const db = asD1(raw);
    const base: MusuboConditionDefinition = {
      id: 'partner-v1', version: 1, internalName: '特約店', status: 'inactive',
      trialPeriod: { unit: 'months', value: 3 }, lineBasicDiscountPercent: 50,
      discountEndsOn: null, approvalUseUntil: '2026-11-30',
      allowedCompanyName: '株式会社サンプル', schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
    };
    expect(await createMusuboPricingCondition(db, {
      conditionKey: 'partner', definition: base, codeDigest: null, validFrom: null,
      createdBy: 'operator', now: '2026-11-01T00:00:00+09:00',
    })).toBe(true);
    expect(await activateMusuboPricingCondition(db, base.id, '2026-11-01T00:00:00+09:00')).toBe(true);
    expect(await approveRegistrationWithMusuboCondition(db, {
      applicationId: 'application-1', conditionId: base.id, actorId: 'operator',
      now: '2026-12-01T10:00:00+09:00',
    })).toBeNull();
    raw.prepare('UPDATE registration_applications SET company_name=? WHERE id=?').run('別の会社', 'application-1');
    expect(await approveRegistrationWithMusuboCondition(db, {
      applicationId: 'application-1', conditionId: base.id, actorId: 'operator',
      now: '2026-11-09T10:00:00+09:00',
    })).toBeNull();
    raw.prepare('UPDATE registration_applications SET company_name=? WHERE id=?').run('株式会社サンプル', 'application-1');
    const snapshot = await approveRegistrationWithMusuboCondition(db, {
      applicationId: 'application-1', conditionId: base.id, actorId: 'operator',
      now: '2026-11-09T10:00:00+09:00',
    });
    expect(snapshot).toMatchObject({ sourceConditionId: base.id, sourceVersion: 1,
      lineBasicDiscountPercent: 50, trialPeriod: { unit: 'months', value: 3 } });
    const saved = raw.prepare('SELECT pricing_snapshot_json FROM registration_applications WHERE id=?')
      .get('application-1') as { pricing_snapshot_json: string };
    expect(JSON.parse(saved.pricing_snapshot_json)).toEqual(snapshot);
    expect(await approveRegistrationWithMusuboCondition(db, {
      applicationId: 'application-1', conditionId: base.id, actorId: 'operator',
      now: '2026-11-10T10:00:00+09:00',
    })).toBeNull();
    expect(await createMusuboPricingCondition(db, {
      conditionKey: 'partner', definition: { ...base, id: 'partner-v2', version: 2, lineBasicDiscountPercent: 20 },
      codeDigest: null, validFrom: null, createdBy: 'operator', now: '2026-11-10T00:00:00+09:00',
    })).toBe(true);
    expect(await activateMusuboPricingCondition(db, 'partner-v2', '2026-11-10T00:00:00+09:00')).toBe(true);
    expect(JSON.parse(saved.pricing_snapshot_json)).toEqual(snapshot);
    expect(raw.prepare(`SELECT status FROM musubo_pricing_conditions WHERE id='partner-v1'`).get()).toEqual({ status: 'disabled' });
  } finally {
    raw.close();
  }
});
