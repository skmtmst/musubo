import {
  applyMusuboConditionAtApproval,
  validateMusuboCondition,
  type AppliedMusuboCondition,
  type MusuboConditionDefinition,
  type MusuboPriceSchedule,
} from '@line-crm/shared';
import { jstNow } from './utils.js';

export interface MusuboPricingConditionRecord {
  id: string;
  condition_key: string;
  version: number;
  name: string;
  code_digest: string | null;
  company_name_key: string | null;
  valid_from: string | null;
  valid_until: string | null;
  status: 'draft' | 'active' | 'disabled';
  trial_unit: 'days' | 'months';
  trial_value: number;
  line_discount_percent: number;
  discount_ends_on: string | null;
  price_schedule_json: string;
  created_by: string;
  created_at: string;
  activated_at: string | null;
  disabled_at: string | null;
}

export function normalizeMusuboCompanyName(name: string): string {
  return name.normalize('NFKC').trim().replace(/\s+/g, '');
}

export function musuboPricingConditionDefinition(row: MusuboPricingConditionRecord): MusuboConditionDefinition {
  return {
    id: row.id,
    version: row.version,
    internalName: row.name,
    status: row.status === 'active' ? 'active' : 'inactive',
    trialPeriod: { unit: row.trial_unit, value: row.trial_value },
    lineBasicDiscountPercent: row.line_discount_percent,
    discountEndsOn: row.discount_ends_on,
    approvalUseUntil: row.valid_until,
    allowedCompanyName: row.company_name_key,
    schedule: JSON.parse(row.price_schedule_json) as MusuboPriceSchedule,
  };
}

export async function getMusuboPricingCondition(db: D1Database, id: string): Promise<MusuboPricingConditionRecord | null> {
  return db.prepare('SELECT * FROM musubo_pricing_conditions WHERE id=?').bind(id).first<MusuboPricingConditionRecord>();
}

export async function listMusuboPricingConditions(db: D1Database): Promise<MusuboPricingConditionRecord[]> {
  const rows = await db.prepare(`SELECT * FROM musubo_pricing_conditions
    ORDER BY condition_key, version DESC LIMIT 200`).all<MusuboPricingConditionRecord>();
  return rows.results ?? [];
}

export async function nextMusuboPricingConditionVersion(db: D1Database, conditionKey: string): Promise<number> {
  const row = await db.prepare(`SELECT MAX(version) AS latest FROM musubo_pricing_conditions WHERE condition_key=?`)
    .bind(conditionKey).first<{ latest: number | null }>();
  return (row?.latest ?? 0) + 1;
}

/** A version's prices are immutable after creation. A later revision gets a new id and version. */
export async function createMusuboPricingCondition(db: D1Database, input: {
  conditionKey: string;
  definition: MusuboConditionDefinition;
  codeDigest: string | null;
  validFrom: string | null;
  createdBy: string;
  now?: string;
}): Promise<boolean> {
  const { definition } = input;
  validateMusuboCondition(definition);
  if (!input.conditionKey.trim() || !input.createdBy.trim()) throw new RangeError('Condition key and creator are required');
  if (input.codeDigest !== null && !/^[a-f0-9]{64}$/.test(input.codeDigest)) throw new RangeError('Invalid code digest');
  if (input.validFrom !== null && !/^\d{4}-\d{2}-\d{2}$/.test(input.validFrom)) throw new RangeError('Invalid validFrom');
  const now = input.now ?? jstNow();
  const result = await db.prepare(`INSERT OR IGNORE INTO musubo_pricing_conditions
    (id,condition_key,version,name,code_digest,company_name_key,valid_from,valid_until,status,
     trial_unit,trial_value,line_discount_percent,discount_ends_on,price_schedule_json,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?)`)
    .bind(definition.id, input.conditionKey.trim(), definition.version, definition.internalName.trim(),
      input.codeDigest, definition.allowedCompanyName === null ? null : normalizeMusuboCompanyName(definition.allowedCompanyName),
      input.validFrom, definition.approvalUseUntil, definition.trialPeriod.unit, definition.trialPeriod.value,
      definition.lineBasicDiscountPercent, definition.discountEndsOn, JSON.stringify(definition.schedule), input.createdBy, now).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Only the selected draft becomes active; the previous version is disabled atomically. */
export async function activateMusuboPricingCondition(db: D1Database, id: string, now = jstNow()): Promise<boolean> {
  const selected = await getMusuboPricingCondition(db, id);
  if (!selected || selected.status !== 'draft') return false;
  const results = await db.batch([
    db.prepare(`UPDATE musubo_pricing_conditions SET status='disabled',disabled_at=?
      WHERE condition_key=? AND status='active'
      AND EXISTS (SELECT 1 FROM musubo_pricing_conditions WHERE id=? AND status='draft')`)
      .bind(now, selected.condition_key, id),
    db.prepare(`UPDATE musubo_pricing_conditions SET status='active',activated_at=?
      WHERE id=? AND condition_key=? AND status='draft'`).bind(now, id, selected.condition_key),
  ]);
  return (results[1]?.meta?.changes ?? 0) === 1;
}

export async function disableMusuboPricingCondition(db: D1Database, conditionKey: string, now = jstNow()): Promise<boolean> {
  if (conditionKey === 'normal') return false;
  const result = await db.prepare(`UPDATE musubo_pricing_conditions SET status='disabled',disabled_at=?
    WHERE condition_key=? AND status='active'`).bind(now, conditionKey).run();
  return (result.meta?.changes ?? 0) === 1;
}

/** Select a condition while approving; one guarded write fixes the price snapshot and approval together. */
export async function approveRegistrationWithMusuboCondition(db: D1Database, input: {
  applicationId: string;
  conditionId: string | null;
  actorId: string;
  now?: string;
}): Promise<AppliedMusuboCondition | null> {
  const application = await db.prepare(`SELECT id,company_name FROM registration_applications
    WHERE id=? AND status='contacted' AND contact_note IS NOT NULL AND length(trim(contact_note))>0`)
    .bind(input.applicationId).first<{ id: string; company_name: string }>();
  if (!application) return null;
  const now = input.now ?? jstNow();
  const approvalDay = now.slice(0, 10);
  const row = input.conditionId === null
    ? await db.prepare(`SELECT * FROM musubo_pricing_conditions WHERE condition_key='normal' AND status='active'`)
      .first<MusuboPricingConditionRecord>()
    : await getMusuboPricingCondition(db, input.conditionId);
  if (!row || row.status !== 'active') return null;
  if (row?.valid_from && approvalDay < row.valid_from) return null;
  const definition = musuboPricingConditionDefinition(row);
  let snapshot: AppliedMusuboCondition;
  try {
    snapshot = applyMusuboConditionAtApproval(definition, { companyName: application.company_name, approvedAt: approvalDay });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const activeConditionGuard = `AND EXISTS (SELECT 1 FROM musubo_pricing_conditions c WHERE c.id=? AND c.status='active'
    AND (c.valid_from IS NULL OR c.valid_from<=?) AND (c.valid_until IS NULL OR c.valid_until>=?))`;
  const statement = db.prepare(`UPDATE registration_applications
    SET status='approved', approved_by=?, approved_at=?, pricing_condition_id=?, pricing_snapshot_json=?, updated_at=?
    WHERE id=? AND company_name=? AND status='contacted'
      AND contact_note IS NOT NULL AND length(trim(contact_note))>0 ${activeConditionGuard}`);
  const values = [input.actorId, now, row.id, JSON.stringify(snapshot), now,
    application.id, application.company_name, row.id, approvalDay, approvalDay];
  const result = await statement.bind(...values).run();
  return (result.meta?.changes ?? 0) === 1 ? snapshot : null;
}
