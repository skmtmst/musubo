import { linkedAccountSlots, type LinkedAccountCounts } from './musubo-pricing.js';
import type { MusuboLinkedService } from './musubo-linked-addition.js';

export interface MusuboLinkedRemovalInput {
  before: LinkedAccountCounts;
  service: MusuboLinkedService;
  slotUnitYen: number;
}

export interface MusuboLinkedRemovalPrice {
  before: LinkedAccountCounts;
  after: LinkedAccountCounts;
  slotsBefore: number;
  slotsAfter: number;
  removedSlots: number;
  monthlyDecreaseYen: number;
  monthlySlotsAfterYen: number;
  refundNowYen: 0;
}

/** Stop the connection immediately; the returned reduction applies at the next monthly billing boundary. */
export function musuboLinkedRemovalPrice(input: MusuboLinkedRemovalInput): MusuboLinkedRemovalPrice {
  if (input.service !== 'googleBusiness' && input.service !== 'instagram') throw new RangeError('Invalid linked service');
  if (!Number.isSafeInteger(input.slotUnitYen) || input.slotUnitYen < 0) throw new RangeError('slotUnitYen must be nonnegative JPY');
  const slotsBefore = linkedAccountSlots(input.before);
  if (input.before.googleBusiness > 10 || input.before.instagram > 10) {
    throw new RangeError('An individual quote is required for eleven or more linked accounts');
  }
  if (input.before[input.service] < 1) throw new RangeError('There is no linked account to remove');
  const after = { ...input.before, [input.service]: input.before[input.service] - 1 };
  const slotsAfter = linkedAccountSlots(after);
  const removedSlots = slotsBefore - slotsAfter;
  const monthlyDecreaseYen = removedSlots * input.slotUnitYen;
  const monthlySlotsAfterYen = slotsAfter * input.slotUnitYen;
  if (!Number.isSafeInteger(monthlyDecreaseYen) || !Number.isSafeInteger(monthlySlotsAfterYen)) {
    throw new RangeError('Linked-account price exceeds the safe JPY range');
  }
  return { before: { ...input.before }, after, slotsBefore, slotsAfter, removedSlots,
    monthlyDecreaseYen, monthlySlotsAfterYen, refundNowYen: 0 };
}
