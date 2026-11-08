import { linkedAccountSlots, prorateMonthlyIncrement, type LinkedAccountCounts } from './musubo-pricing.js';

export type MusuboLinkedService = 'googleBusiness' | 'instagram';

export interface MusuboLinkedAdditionInput {
  before: LinkedAccountCounts;
  service: MusuboLinkedService;
  slotUnitYen: number;
  /** Additional linked slots bill monthly, including when LINE base fees bill annually. */
  billing: { kind: 'trialing' } | { kind: 'paid'; monthlyDaysRemaining: number; monthlyDaysInPeriod: number };
}

export interface MusuboLinkedAdditionPrice {
  before: LinkedAccountCounts;
  after: LinkedAccountCounts;
  slotsBefore: number;
  slotsAfter: number;
  addedSlots: number;
  monthlyIncreaseYen: number;
  monthlySlotsAfterYen: number;
  dueNowYen: number;
}

/** An addition to one LINE uses the larger linked-service count, not their sum. */
export function musuboLinkedAdditionPrice(input: MusuboLinkedAdditionInput): MusuboLinkedAdditionPrice {
  if (input.service !== 'googleBusiness' && input.service !== 'instagram') throw new RangeError('Invalid linked service');
  if (!Number.isSafeInteger(input.slotUnitYen) || input.slotUnitYen < 0) throw new RangeError('slotUnitYen must be nonnegative JPY');
  const slotsBefore = linkedAccountSlots(input.before);
  if (input.before.googleBusiness > 10 || input.before.instagram > 10 || input.before[input.service] >= 10) {
    throw new RangeError('An individual quote is required for eleven or more linked accounts');
  }
  const after = { ...input.before, [input.service]: input.before[input.service] + 1 };
  const slotsAfter = linkedAccountSlots(after);
  const addedSlots = slotsAfter - slotsBefore;
  const monthlyIncreaseYen = addedSlots * input.slotUnitYen;
  const monthlySlotsAfterYen = slotsAfter * input.slotUnitYen;
  if (!Number.isSafeInteger(monthlyIncreaseYen) || !Number.isSafeInteger(monthlySlotsAfterYen)) {
    throw new RangeError('Linked-account price exceeds the safe JPY range');
  }
  const dueNowYen = input.billing.kind === 'trialing' ? 0
    : input.billing.kind === 'paid'
      ? prorateMonthlyIncrement(monthlyIncreaseYen, input.billing.monthlyDaysRemaining, input.billing.monthlyDaysInPeriod)
      : (() => { throw new RangeError('Invalid billing phase'); })();
  return { before: { ...input.before }, after, slotsBefore, slotsAfter, addedSlots,
    monthlyIncreaseYen, monthlySlotsAfterYen, dueNowYen };
}
