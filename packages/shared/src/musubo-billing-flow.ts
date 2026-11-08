/** Billing rules agreed for the new musubo onboarding. All timestamps are absolute ISO instants. */
import { utcCalendarDate } from './musubo-pricing.js';
const DAY_MS = 24 * 60 * 60 * 1000;
export const PAYMENT_GRACE_DAYS = 7;
export const ADDITION_HOLD_DAYS = 7;

function instant(value: string, name: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new RangeError(name + ' must be an ISO timestamp with timezone');
  }
  return timestamp;
}

export interface IndividualQuoteState {
  issuedAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  supersededAt: string | null;
}

/**
 * Acceptance before expiry locks the quoted final unit prices. Card registration may
 * continue later. A superseded link cannot start a new acceptance.
 */
export function individualQuoteAccess(quote: IndividualQuoteState, now: string): 'available' | 'expired' | 'accepted' | 'superseded' {
  const issued = instant(quote.issuedAt, 'issuedAt');
  const expires = instant(quote.expiresAt, 'expiresAt');
  const current = instant(now, 'now');
  if (expires <= issued) throw new RangeError('expiresAt must be after issuedAt');
  if (current < issued) throw new RangeError('Quote has not been issued');
  const accepted = quote.acceptedAt === null ? null : instant(quote.acceptedAt, 'acceptedAt');
  const superseded = quote.supersededAt === null ? null : instant(quote.supersededAt, 'supersededAt');
  if (accepted !== null && accepted >= issued && accepted <= expires && accepted <= current
    && (superseded === null || accepted < superseded)) {
    return 'accepted';
  }
  if (superseded !== null && superseded <= current) return 'superseded';
  return current > expires ? 'expired' : 'available';
}

export interface InvoiceFailureState {
  failedAt: string;
  paidAt?: string | null;
}

/** Existing usage remains available for exactly seven days after a failed paid invoice. */
export function invoiceFailureAccess(state: InvoiceFailureState, now: string): {
  state: 'grace' | 'suspended' | 'recovered';
  deadline: string;
  daysRemaining: number;
  sendDaySixWarning: boolean;
} {
  const failed = instant(state.failedAt, 'failedAt');
  const current = instant(now, 'now');
  const deadline = failed + PAYMENT_GRACE_DAYS * DAY_MS;
  const paid = state.paidAt ? instant(state.paidAt, 'paidAt') : null;
  if (paid !== null && paid >= failed && paid <= current) {
    return { state: 'recovered', deadline: new Date(deadline).toISOString(), daysRemaining: 0, sendDaySixWarning: false };
  }
  const grace = current < deadline;
  return {
    state: grace ? 'grace' : 'suspended',
    deadline: new Date(deadline).toISOString(),
    daysRemaining: grace ? Math.ceil((deadline - current) / DAY_MS) : 0,
    sendDaySixWarning: grace && current >= failed + 6 * DAY_MS,
  };
}

export interface PendingAdditionState {
  requestedAt: string;
  paymentSucceededAt?: string | null;
  cancelledAt?: string | null;
}

/** A failed incremental charge never affects the already active LINE accounts. */
export function pendingAdditionAccess(state: PendingAdditionState, now: string): {
  state: 'pending' | 'activate' | 'expired' | 'cancelled';
  holdUntil: string;
  existingUsageAllowed: true;
} {
  const requested = instant(state.requestedAt, 'requestedAt');
  const current = instant(now, 'now');
  const holdUntil = requested + ADDITION_HOLD_DAYS * DAY_MS;
  const paid = state.paymentSucceededAt ? instant(state.paymentSucceededAt, 'paymentSucceededAt') : null;
  const cancelled = state.cancelledAt ? instant(state.cancelledAt, 'cancelledAt') : null;
  let status: 'pending' | 'activate' | 'expired' | 'cancelled' = 'pending';
  if (paid !== null && paid <= current && paid < holdUntil && (cancelled === null || paid < cancelled)) status = 'activate';
  else if (cancelled !== null && cancelled <= current) status = 'cancelled';
  else if (current >= holdUntil) status = 'expired';
  return { state: status, holdUntil: new Date(holdUntil).toISOString(), existingUsageAllowed: true };
}

function jstCalendarDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/**
 * The final LINE normally stays available through the day BEFORE the next charge.
 * Trial uses the first-charge date, monthly uses the next monthly charge and annual
 * uses the next annual renewal. Immediate closure is a separate explicit choice.
 */
export function finalLineEndOption(input: {
  billingState: 'trialing' | 'active';
  interval: 'month' | 'year';
  trialFirstChargeAt?: string;
  nextMonthlyChargeAt?: string;
  nextAnnualRenewalAt?: string;
}, now: string): { defaultEndAt: string; lastUsableDateJst: string; immediateAllowed: true; refundOnImmediateEnd: false } {
  const current = instant(now, 'now');
  const chargeAt = input.billingState === 'trialing' ? input.trialFirstChargeAt
    : input.interval === 'month' ? input.nextMonthlyChargeAt : input.nextAnnualRenewalAt;
  if (!chargeAt) throw new RangeError('A next charge or renewal date is required');
  const chargeDateJst = jstCalendarDate(instant(chargeAt, 'chargeAt'));
  const endsAt = Date.parse(`${chargeDateJst}T00:00:00+09:00`);
  if (endsAt <= current) throw new RangeError('The final usable date must be in the future');
  const previous = new Date(`${chargeDateJst}T00:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return {
    defaultEndAt: new Date(endsAt).toISOString(),
    lastUsableDateJst: utcCalendarDate(previous),
    immediateAllowed: true,
    refundOnImmediateEnd: false,
  };
}

/** Slot deletion stops the connection now; the lower charge starts on the next monthly invoice even on an annual LINE plan. */
export function linkedSlotRemoval(input: { disconnectedAt: string; nextMonthlyChargeAt: string }): {
  accessEndsAt: string;
  reducedChargeStartsAt: string;
  refundDue: false;
} {
  const disconnected = instant(input.disconnectedAt, 'disconnectedAt');
  const nextCharge = instant(input.nextMonthlyChargeAt, 'nextMonthlyChargeAt');
  if (nextCharge <= disconnected) throw new RangeError('nextMonthlyChargeAt must be later');
  return {
    accessEndsAt: new Date(disconnected).toISOString(),
    reducedChargeStartsAt: new Date(nextCharge).toISOString(),
    refundDue: false,
  };
}
