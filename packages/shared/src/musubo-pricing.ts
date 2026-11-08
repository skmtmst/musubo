/** Prices shown in the onboarding flow are tax inclusive JPY. */
export interface MusuboPriceSchedule {
  firstLineYen: number;
  secondToFifthLineYen: number;
  sixthToTenthLineYen: number;
  eleventhAndLaterLineYen?: number;
  headquartersYen: number;
  linkedAccountSlotYen: number;
  extraFriendBlockYen: number;
  extraFriendBlockSize: number;
  friendAllowanceForElevenOrMore?: number;
}

export const DEFAULT_MUSUBO_PRICE_SCHEDULE: Readonly<MusuboPriceSchedule> = Object.freeze({
  firstLineYen: 5_900,
  secondToFifthLineYen: 7_900,
  sixthToTenthLineYen: 6_900,
  headquartersYen: 5_500,
  linkedAccountSlotYen: 3_300,
  extraFriendBlockYen: 1_100,
  extraFriendBlockSize: 10_000,
});

export interface LinkedAccountCounts {
  googleBusiness: number;
  instagram: number;
}

export interface MusuboPriceInput {
  lineCount: number;
  friendCountExcludingBlocked: number;
  linkedAccountsByLine?: readonly LinkedAccountCounts[];
  interval: 'month' | 'year';
  /** A company-specific discount on LINE base prices only. */
  lineBasicDiscountPercent?: number;
  schedule?: MusuboPriceSchedule;
  /** Only an accepted individual quote may price eleven or more linked accounts. */
  individualQuoteAccepted?: boolean;
}

export interface MusuboPriceBreakdown {
  lineCount: number;
  friendAllowance: number;
  extraFriendBlocks: number;
  linkedAccountSlots: number;
  lineBasicBeforeDiscountYen: number;
  lineBasicMonthlyYen: number;
  lineBasicAnnualYen: number;
  headquartersMonthlyYen: number;
  friendOverageMonthlyYen: number;
  linkedAccountSlotsMonthlyYen: number;
  optionsMonthlyYen: number;
  /** The amount due each month on a monthly plan, after the trial. */
  monthlyTotalYen: number;
  /** Annual LINE base charge; options still recur monthly. */
  annualLineChargeYen: number;
}

function wholeNonnegative(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative whole number`);
  return value;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive whole number`);
  return value;
}

/** More of Google Business and Instagram, minus the first included slot. */
export function linkedAccountSlots(counts: LinkedAccountCounts): number {
  const google = wholeNonnegative(counts.googleBusiness, 'googleBusiness');
  const instagram = wholeNonnegative(counts.instagram, 'instagram');
  return Math.max(0, Math.max(google, instagram) - 1);
}

export function friendAllowanceForLineCount(lineCount: number, schedule: MusuboPriceSchedule): number {
  positive(lineCount, 'lineCount');
  if (lineCount === 1) return 3_000;
  if (lineCount <= 5) return 15_000;
  if (lineCount <= 10) return 50_000;
  if (schedule.friendAllowanceForElevenOrMore === undefined) {
    throw new RangeError('An individual quote is required for eleven or more LINE accounts');
  }
  return wholeNonnegative(schedule.friendAllowanceForElevenOrMore, 'friendAllowanceForElevenOrMore');
}

export function musuboPrice(input: MusuboPriceInput): MusuboPriceBreakdown {
  const schedule = input.schedule ?? DEFAULT_MUSUBO_PRICE_SCHEDULE;
  const lineCount = positive(input.lineCount, 'lineCount');
  const friendCount = wholeNonnegative(input.friendCountExcludingBlocked, 'friendCountExcludingBlocked');
  const discount = wholeNonnegative(input.lineBasicDiscountPercent ?? 0, 'lineBasicDiscountPercent');
  if (discount > 100) throw new RangeError('lineBasicDiscountPercent must be at most 100');
  if (input.interval !== 'month' && input.interval !== 'year') throw new RangeError('Invalid interval');
  for (const name of ['firstLineYen', 'secondToFifthLineYen', 'sixthToTenthLineYen', 'headquartersYen', 'linkedAccountSlotYen', 'extraFriendBlockYen'] as const) {
    wholeNonnegative(schedule[name], name);
  }
  positive(schedule.extraFriendBlockSize, 'extraFriendBlockSize');
  const linked = input.linkedAccountsByLine ?? [];
  if (linked.length > lineCount) throw new RangeError('More linked account entries than LINE accounts');
  if (linked.some((counts) => counts.googleBusiness > 10 || counts.instagram > 10) && !input.individualQuoteAccepted) {
    throw new RangeError('An accepted individual quote is required for eleven or more linked accounts');
  }
  const allowance = friendAllowanceForLineCount(lineCount, schedule);
  const basicBeforeDiscount = schedule.firstLineYen
    + Math.min(Math.max(lineCount - 1, 0), 4) * schedule.secondToFifthLineYen
    + Math.min(Math.max(lineCount - 5, 0), 5) * schedule.sixthToTenthLineYen
    + Math.max(lineCount - 10, 0) * (schedule.eleventhAndLaterLineYen ?? 0);
  if (lineCount > 10 && schedule.eleventhAndLaterLineYen === undefined) {
    throw new RangeError('An individual quote is required for eleven or more LINE accounts');
  }
  const lineBasicMonthlyYen = Math.floor(basicBeforeDiscount * (100 - discount) / 100);
  const lineBasicAnnualYen = Math.floor(basicBeforeDiscount * (100 - discount) * 12 * 90 / 10_000);
  const extraFriendBlocks = Math.ceil(Math.max(friendCount - allowance, 0) / schedule.extraFriendBlockSize);
  const slots = linked.reduce((sum, counts) => sum + linkedAccountSlots(counts), 0);
  const headquartersMonthlyYen = lineCount > 1 ? schedule.headquartersYen : 0;
  const friendOverageMonthlyYen = extraFriendBlocks * schedule.extraFriendBlockYen;
  const linkedAccountSlotsMonthlyYen = slots * schedule.linkedAccountSlotYen;
  const optionsMonthlyYen = headquartersMonthlyYen + friendOverageMonthlyYen + linkedAccountSlotsMonthlyYen;
  return {
    lineCount,
    friendAllowance: allowance,
    extraFriendBlocks,
    linkedAccountSlots: slots,
    lineBasicBeforeDiscountYen: basicBeforeDiscount,
    lineBasicMonthlyYen,
    lineBasicAnnualYen,
    headquartersMonthlyYen,
    friendOverageMonthlyYen,
    linkedAccountSlotsMonthlyYen,
    optionsMonthlyYen,
    monthlyTotalYen: lineBasicMonthlyYen + optionsMonthlyYen,
    annualLineChargeYen: lineBasicAnnualYen,
  };
}

/** The next charge is calculated from the initial LINE activation date, never card registration. */
export interface MusuboTrialPeriod {
  unit: 'days' | 'months';
  value: number;
}

function parseIsoDate(date: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError('Expected YYYY-MM-DD');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || utcCalendarDate(parsed) !== date) throw new RangeError('Invalid date');
  return parsed;
}

/** Date-only arithmetic here uses UTC fields as a timezone-free calendar. */
export function utcCalendarDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isoDate(date: Date): string { return utcCalendarDate(date); }

/** `firstChargeDate` is exclusive: the last free date is the previous JST calendar date. */
export function musuboTrialDates(activationDateJst: string, period: MusuboTrialPeriod): {
  activationDate: string;
  lastFreeDate: string;
  firstChargeDate: string;
} {
  const start = parseIsoDate(activationDateJst);
  const value = positive(period.value, 'trial period');
  let end: Date;
  if (period.unit === 'days') {
    end = new Date(start.getTime());
    end.setUTCDate(end.getUTCDate() + value);
  } else if (period.unit === 'months') {
    const target = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + value, 1));
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(start.getUTCDate(), last));
    end = target;
  } else {
    throw new RangeError('Invalid trial period unit');
  }
  const lastFree = new Date(end.getTime());
  lastFree.setUTCDate(lastFree.getUTCDate() - 1);
  return { activationDate: activationDateJst, lastFreeDate: isoDate(lastFree), firstChargeDate: isoDate(end) };
}

/** Calculate an immediate incremental charge for the remaining days of this monthly period. */
export function prorateMonthlyIncrement(monthlyIncrementYen: number, daysRemaining: number, daysInPeriod: number): number {
  wholeNonnegative(monthlyIncrementYen, 'monthlyIncrementYen');
  wholeNonnegative(daysRemaining, 'daysRemaining');
  positive(daysInPeriod, 'daysInPeriod');
  if (daysRemaining > daysInPeriod) throw new RangeError('daysRemaining exceeds daysInPeriod');
  return Math.floor(monthlyIncrementYen * daysRemaining / daysInPeriod);
}

/**
 * An annual LINE addition charges only the remaining JST calendar days of the
 * already paid annual period. The annual increment already includes any
 * company discount and the LINE-only ten percent annual discount.
 */
export function prorateAnnualLineIncrement(input: {
  annualIncrementYen: number;
  periodStartDateJst: string;
  activationDateJst: string;
  renewalDateJst: string;
}): { chargeYen: number; remainingDays: number; annualPeriodDays: number } {
  const annual = wholeNonnegative(input.annualIncrementYen, 'annualIncrementYen');
  const start = parseIsoDate(input.periodStartDateJst).getTime();
  const activated = parseIsoDate(input.activationDateJst).getTime();
  const renewal = parseIsoDate(input.renewalDateJst).getTime();
  if (start >= renewal || activated < start || activated >= renewal) {
    throw new RangeError('Activation must fall within the annual billing period');
  }
  const annualPeriodDays = (renewal - start) / (24 * 60 * 60 * 1000);
  const remainingDays = (renewal - activated) / (24 * 60 * 60 * 1000);
  return {
    chargeYen: Math.floor(annual * remainingDays / annualPeriodDays),
    remainingDays,
    annualPeriodDays,
  };
}
