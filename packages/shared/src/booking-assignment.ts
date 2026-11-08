/** 人の予約はLINEアカウント、席の予約は飲食店舗を設定の単位にする。 */
export type BookingAssignmentMethod = 'balanced' | 'priority' | 'random';
export type BookingAssignmentPeriod = 'day' | 'week';
export type BookingAssignmentPriority = 'preferred' | 'normal' | 'low';
export interface BookingAssignmentResource {
  resourceId: string;
  priority: BookingAssignmentPriority;
  dailyLimit: number | null;
  sortOrder: number;
}
export interface BookingAssignmentWrite {
  method: BookingAssignmentMethod;
  balancePeriod: BookingAssignmentPeriod;
  resources: BookingAssignmentResource[];
  expectedVersion: number;
}
export interface BookingAssignmentSettings {
  method: BookingAssignmentMethod;
  balancePeriod: BookingAssignmentPeriod;
  resources: BookingAssignmentResource[];
  version: number;
  storageReady: boolean;
  effectiveMethod: BookingAssignmentMethod | 'legacy_first';
}

/** 飲食店全体の自動配席。担当スタッフの割り当て設定とは別に保存する。 */
export interface RestaurantTableAssignmentSettings {
  enabled: boolean;
  version: number;
}
export interface RestaurantTableAssignmentWrite {
  enabled: boolean;
  expectedVersion: number;
}
