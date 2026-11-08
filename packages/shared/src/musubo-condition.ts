import { DEFAULT_MUSUBO_PRICE_SCHEDULE, musuboPrice, type MusuboPriceSchedule, type MusuboTrialPeriod } from './musubo-pricing.js';

export interface MusuboConditionDefinition {
  id: string;
  version: number;
  internalName: string;
  status: 'active' | 'inactive';
  trialPeriod: MusuboTrialPeriod;
  lineBasicDiscountPercent: number;
  /** Null means the LINE basic discount has no end date. */
  discountEndsOn: string | null;
  /** Null means the condition can be chosen at any approval date. */
  approvalUseUntil: string | null;
  /** When set, operations may assign this condition only to this exact legal company name. */
  allowedCompanyName: string | null;
  schedule: MusuboPriceSchedule;
}

export interface AppliedMusuboCondition {
  sourceConditionId: string;
  sourceVersion: number;
  internalName: string;
  appliedAt: string;
  trialPeriod: MusuboTrialPeriod;
  lineBasicDiscountPercent: number;
  discountEndsOn: string | null;
  schedule: MusuboPriceSchedule;
}

function validDate(value: string, name: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError(name + ' must be YYYY-MM-DD');
  const date = new Date(value + 'T00:00:00.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new RangeError(name + ' is invalid');
  return value;
}

function normalizedCompanyName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '');
}

function validPrice(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(name + ' must be a nonnegative integer');
  return value;
}

export function validateMusuboCondition(definition: MusuboConditionDefinition): void {
  if (!definition.id || !definition.internalName.trim()) throw new RangeError('Condition id and name are required');
  if (!Number.isSafeInteger(definition.version) || definition.version < 1) throw new RangeError('Condition version must be positive');
  if (definition.status !== 'active' && definition.status !== 'inactive') throw new RangeError('Invalid condition status');
  if (definition.trialPeriod.unit !== 'days' && definition.trialPeriod.unit !== 'months') throw new RangeError('Invalid trial period');
  if (!Number.isSafeInteger(definition.trialPeriod.value) || definition.trialPeriod.value < 1 || definition.trialPeriod.value > 365) {
    throw new RangeError('Trial period must be between 1 and 365');
  }
  if (definition.trialPeriod.unit === 'months' && definition.trialPeriod.value > 12) throw new RangeError('Trial months must be at most 12');
  if (!Number.isSafeInteger(definition.lineBasicDiscountPercent) || definition.lineBasicDiscountPercent < 0 || definition.lineBasicDiscountPercent > 100) {
    throw new RangeError('LINE basic discount must be between 0 and 100 percent');
  }
  if (definition.approvalUseUntil !== null) validDate(definition.approvalUseUntil, 'approvalUseUntil');
  if (definition.discountEndsOn !== null) validDate(definition.discountEndsOn, 'discountEndsOn');
  if (definition.allowedCompanyName !== null && !normalizedCompanyName(definition.allowedCompanyName)) {
    throw new RangeError('allowedCompanyName cannot be blank');
  }
  for (const key of ['firstLineYen', 'secondToFifthLineYen', 'sixthToTenthLineYen',
    'headquartersYen', 'linkedAccountSlotYen', 'extraFriendBlockYen'] as const) {
    validPrice(definition.schedule[key], key);
  }
  if (!Number.isSafeInteger(definition.schedule.extraFriendBlockSize) || definition.schedule.extraFriendBlockSize < 1) {
    throw new RangeError('Invalid friend block size');
  }
}

/**
 * Operations chooses a condition at approval. Eligibility is checked server-side.
 * The returned snapshot is immutable contract data for this application, so edits
 * to the reusable definition never retroactively change an approved company.
 */
export function applyMusuboConditionAtApproval(definition: MusuboConditionDefinition, input: {
  companyName: string;
  approvedAt: string;
}): AppliedMusuboCondition {
  validateMusuboCondition(definition);
  const approvedAt = validDate(input.approvedAt, 'approvedAt');
  if (definition.status !== 'active') throw new RangeError('Inactive condition cannot be applied');
  if (definition.approvalUseUntil !== null && approvedAt > definition.approvalUseUntil) {
    throw new RangeError('Condition approval deadline has passed');
  }
  if (definition.allowedCompanyName !== null
    && normalizedCompanyName(input.companyName) !== normalizedCompanyName(definition.allowedCompanyName)) {
    throw new RangeError('Condition is restricted to another company');
  }
  return {
    sourceConditionId: definition.id,
    sourceVersion: definition.version,
    internalName: definition.internalName,
    appliedAt: approvedAt,
    trialPeriod: { ...definition.trialPeriod },
    lineBasicDiscountPercent: definition.lineBasicDiscountPercent,
    discountEndsOn: definition.discountEndsOn,
    schedule: { ...definition.schedule },
  };
}

export function musuboConditionPreview(definition: MusuboConditionDefinition): { oneLineMonthlyYen: number; twoLineMonthlyYen: number } {
  validateMusuboCondition(definition);
  const base = { friendCountExcludingBlocked: 0, interval: 'month' as const,
    lineBasicDiscountPercent: definition.lineBasicDiscountPercent, schedule: definition.schedule };
  return {
    oneLineMonthlyYen: musuboPrice({ ...base, lineCount: 1 }).monthlyTotalYen,
    twoLineMonthlyYen: musuboPrice({ ...base, lineCount: 2 }).monthlyTotalYen,
  };
}

/** The configured LINE-only discount is evaluated for the charge's JST calendar date. */
export function lineBasicDiscountForDate(condition: AppliedMusuboCondition, chargeDateJst: string): number {
  const chargeDate = validDate(chargeDateJst, 'chargeDateJst');
  return condition.discountEndsOn === null || chargeDate <= condition.discountEndsOn
    ? condition.lineBasicDiscountPercent : 0;
}

export const NORMAL_MUSUBO_CONDITION: Readonly<MusuboConditionDefinition> = Object.freeze<MusuboConditionDefinition>({
  id: 'normal',
  version: 1,
  internalName: '通常条件',
  status: 'active',
  trialPeriod: { unit: 'days', value: 30 },
  lineBasicDiscountPercent: 0,
  discountEndsOn: null,
  approvalUseUntil: null,
  allowedCompanyName: null,
  schedule: { ...DEFAULT_MUSUBO_PRICE_SCHEDULE },
});
