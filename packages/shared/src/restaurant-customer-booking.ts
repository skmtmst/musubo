export type RestaurantUnavailableReason =
  | 'temporary_closed' | 'private_event' | 'regular_closed' | 'full';
export interface RestaurantLateArrivalPolicy {
  cancelAfterMinutes: number;
  message: string;
}
export interface RestaurantCustomerDetails {
  note?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
  allergyNote?: string | null;
  expectedFormVersion?: number;
}
export interface RestaurantCustomerConfirmInput extends RestaurantCustomerDetails {
  referralId?: string;
  expectedVersion: number;
}

export interface RestaurantCustomerCourse {
  id: string; name: string; durationMinutes: number; price: number; allergens: string[]; photoUrl?: string | null;
}
export interface RestaurantReferralCandidate {
  storeId: string; storeName: string; distanceKm: number; startsAt: string; endsAt: string; bookingUrl: string;
}
export interface RestaurantCustomerSlot {
  startsAt: string;
  endsAt: string;
  available: boolean;
  remainingTables: number;
  seatTypes: string[];
  unavailableReason?: RestaurantUnavailableReason;
}
export interface RestaurantCustomerAvailability {
  storeId: string;
  date: string;
  guestCount: number;
  slots: RestaurantCustomerSlot[];
  unavailableReason?: RestaurantUnavailableReason;
  lateArrivalPolicy?: RestaurantLateArrivalPolicy;
  cancelDeadlineMinutesBefore: number;
  cutoffMinutesBefore: number;
}
export interface RestaurantCustomerHoldInput extends RestaurantCustomerDetails {
  storeId: string;
  startsAt: string;
  guestCount: number;
  requestId: string;
  courseId?: string | null;
}
export interface RestaurantCustomerBooking {
  id: string;
  storeId: string;
  startsAt: string;
  endsAt: string;
  guestCount: number;
  status: string;
  version: number;
  holdExpiresAt: string | null;
  note: string | null;
  customerPhone: string | null;
  customerName?: string;
  allergyNote?: string | null;
  seatType: string | null;
  courseId?: string | null;
  courseName?: string | null;
}
