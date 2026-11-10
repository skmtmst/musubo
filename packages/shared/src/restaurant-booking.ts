/** V8 飲食店の予約・枠・権限APIの共通契約。 */
export type RestaurantHoldInput = {
  storeId: string; startsAt: string; endsAt: string; guestCount: number;
  tableId?: string | null; holdMinutes: number; note?: string | null;
};
export type RestaurantHoldResult = { id: string; tableId: string; holdExpiresAt: string };
export type RestaurantCustomer = { name: string; phone: string | null; lineUid: string | null };
export type RestaurantVisit = {
  id: string; starts_at: string; guest_count: number; table_label: string | null;
  course_name: string | null; allergy_note: string | null;
};
export type RestaurantCustomerHistory = { visitCount: number; visits: RestaurantVisit[] };
export type RestaurantOpeningDay = { weekday: number; periods: Array<{ opensAt: string; closesAt: string }> };
export type RestaurantOpeningHours = {
  storeId: string; hours: RestaurantOpeningDay[] | null; version: number;
  updatedBy: string | null; updatedAt: string | null;
  googleStatus?: 'connected' | 'pending_location' | 'expired' | 'no_permission' | 'disconnected' | null;
  lateArrivalPolicy?: import('./restaurant-customer-booking.js').RestaurantLateArrivalPolicy | null;
};
export type RestaurantAllocation = { otaCapacity: number; lineCapacity: number; walkInCapacity: number; sameDayCapacity?: number };
export type RestaurantLoginMember = {
  id: string; name: string; role: 'owner' | 'admin' | 'staff'; accessLevel: 'full' | 'read_only';
  isActive: number; accountScope: 'all' | 'accounts'; accountIds: string[]; policyVersion: number;
};
export type RestaurantMenuChangeResult = { id: string; approvalId: string | null; requestId: string | null; pendingPrice: number | null };

export type RestaurantTablePosition = { id: string; floorX: number; floorY: number; joinGroup: string | null };
export type RestaurantTableLayoutInput = { storeId: string; expectedVersion:number; tables: RestaurantTablePosition[] };

export type RestaurantApprovalDecision = { id: string; status: string; menuChangeStatus: 'pending' | 'approved' | 'returned' | 'applied' | 'failed' | null; failureReason: string | null };
