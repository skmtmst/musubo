/** Billing rules agreed for the new musubo onboarding. All timestamps are absolute ISO instants. */
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
  const accepted = quote.acceptedAt === null ? null : instant(quote.acceptedAt, 'acceptedAt');
  const superseded = quote.supersededAt === null ? null : instant(quote.supersededAt, 'supersededAt');
  if (accepted !== null && accepted >= issued && accepted <= expires && (superseded === null || accepted < superseded)) {
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
  if (cancelled !== null && cancelled <= current) status = 'cancelled';
  else if (paid !== null && paid <= current && paid < holdUntil) status = 'activate';
  else if (current >= holdUntil) status = 'expired';
  return { state: status, holdUntil: new Date(holdUntil).toISOString(), existingUsageAllowed: true };
}

/**
 * The final LINE defaults to an end date matching the paid period. A trial can
 * close immediately without starting a charge. Earlier voluntary closure is an
 * explicit alternate action and does not imply a refund.
 */
export function finalLineEndOption(input: {
  billingState: 'trialing' | 'active';
  interval: 'month' | 'year';
  nextMonthlyChargeAt?: string;
  nextAnnualRenewalAt?: string;
}, now: string): { defaultEndAt: string; immediateAllowed: true; refundOnImmediateEnd: false } {
  const current = instant(now, 'now');
  if (input.billingState === 'trialing') {
    return { defaultEndAt: new Date(current).toISOString(), immediateAllowed: true, refundOnImmediateEnd: false };
  }
  const endAt = input.interval === 'month' ? input.nextMonthlyChargeAt : input.nextAnnualRenewalAt;
  if (!endAt || instant(endAt, 'endAt') <= current) throw new RangeError('A future paid-period end is required');
  return { defaultEndAt: new Date(instant(endAt, 'endAt')).toISOString(), immediateAllowed: true, refundOnImmediateEnd: false };
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
