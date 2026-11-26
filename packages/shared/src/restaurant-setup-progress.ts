import type { RestaurantReservationFormHealth } from './restaurant-reservation-form.js';

export interface RestaurantBookingExposure {
  reservationLink: boolean;
  publicReservationMenu: boolean;
  availableCapacity: boolean;
}

/** 選んでいる1店舗の設定状況。空席数や予約件数は完了条件にしない。 */
export interface RestaurantSetupProgress {
  storeId: string;
  lineAccountId?: string | null;
  tables: boolean;
  hours: boolean;
  menus: boolean;
  /** 開店準備のコース登録。公開メニューまたは必須項目を保存したコースの下書きがある。 */
  courseRegistered?: boolean;
  reception: boolean;
  /** 実際の受付を案内するための実測。開店準備の済み判定には含めない。 */
  bookingExposure?: RestaurantBookingExposure;
  followup: boolean;
  reservationForm?: RestaurantReservationFormHealth;
  /** 保存機能導入後のSELECT集計。未提供時は従来のfollowupを使う。 */
  followupSetup?: { notUsing: boolean; decidedAt: string | null; version: number; anyEnabled: boolean };
}
