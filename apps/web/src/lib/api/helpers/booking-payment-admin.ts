import type { SimulatedPaymentResult, PaymentLinkPreview } from '../types/booking-payment-types'
export type { SimulatedPaymentResult, PaymentLinkPreview } from '../types/booking-payment-types'
import { ApiError, fetchApi, fetchApiBlob } from '../../api'

/*
 * 予約のお支払い（管理画面）の口（・）。作業役Dの形を保持する。
 * 通知履歴・コース/クラスの設定には663〜665の適用が必要。
 * 支払いリンクは模擬のみ。sent:false を送信成功として表示しない。
 */

type Result<T> = { success: true; data: T };
const q = (accountId: string, extra?: Record<string, string | number | undefined>) => {
  const params = new URLSearchParams({ account_id: accountId });
  for (const [key, value] of Object.entries(extra ?? {})) if (value !== undefined && value !== '') params.set(key, String(value));
  return params.toString();
};

export type BookingPaymentMode = 'none' | 'onsite' | 'online' | 'customer_choice';

/** Stripe のつなぎの状態。鍵の値は返さない（末尾の数文字だけ）。 */
export interface StripeConnection {
  connected: boolean;
  testMode: boolean;
  accountIdTail: string | null;
  connectedAt: string | null;
  dashboardUrl: string | null;
}

/** メニュー（予約メニュー・コース・クラス）ごとの上書き。上書きの無いメニューは返さない。 */
export interface MenuPaymentOverride {
  menuId: string;
  mode: BookingPaymentMode;
}

export type PaymentRecordStatus = 'paid' | 'partially_refunded' | 'pending' | 'refunded' | 'expired' | 'onsite';

export interface PaymentRecord {
  id: string;
  bookingId: string | null;
  friendId: string | null;
  friendName: string | null;
  bookingStartsAt: string | null;
  bookingLabel: string | null;
  bookingNote: string | null;
  amount: number;
  status: PaymentRecordStatus;
  method: string | null;
  createdAt: string;
  receiptUrl: string | null;
  refundedAmount: number;
  confirmationRevision?: number | null;
  actorLabel: string | null;
  reason: string | null;
}

export interface PaymentSummary {
  paidAmount: number;
  paidCount: number;
  refundedAmount: number;
  refundedCount: number;
  expiredCount: number;
  pendingCount: number;
  holdMinutes: number;
}

export interface PaymentRecordsPage {
  summary: PaymentSummary;
  items: PaymentRecord[];
  total: number;
}

export type PaymentEventResult = 'applied' | 'duplicate' | 'failed';

export interface PaymentEvent {
  id: string;
  receivedAt: string;
  kind: 'paid' | 'refunded' | 'expired' | 'other';
  amount: number | null;
  repeat: boolean;
  bookingId: string | null;
  bookingLabel: string | null;
  note: string | null;
  result: PaymentEventResult;
}

export interface RefundPaymentInput { expectedRevision?: number; amount?: number; reason: string; notifyLine?: boolean; idempotencyKey: string }
export interface PaymentRefund extends SimulatedPaymentResult {
  id: string; amount: number; reason: string; actorLabel: string; createdAt: string;
  notifyLine: boolean; notificationStatus: 'not_requested' | 'simulated' | 'unavailable';
}

export const bookingPaymentAdminApi = {
  /** 接続/つなぎ直し。同じ管理ログインを保って返されたURLを開く（10分間有効）。 */
  authorizeConnection: (accountId: string) =>
    fetchApi<Result<{ authorizationUrl: string; expiresAt: string; testMode: true }>>(`/api/booking/admin/payment-connection/authorize?${q(accountId)}`, { method: 'POST', body: '{}' }),
  /** ブラウザのGET callbackも可。認可コードは自動再送しない。 */
  completeConnection: (accountId: string, callback: { state: string; code: string } | { state: string; error: 'access_denied' }) =>
    fetchApi<Result<StripeConnection>>(`/api/booking/admin/payment-connection/callback?${q(accountId)}`, { method: 'POST', body: JSON.stringify(callback) }),
  disconnectConnection: (accountId: string) =>
    fetchApi<Result<StripeConnection>>(`/api/booking/admin/payment-connection?${q(accountId)}`, { method: 'DELETE' }),
  /** CSV本文。指定の検索条件全件（上限1万件）。ページ送りのoffsetは書出しに使わない。 */
  exportCsv: (accountId: string, filter: { q?: string; status?: string; method?: string; period?: string } = {}) =>
    fetchApiBlob(`/api/booking/admin/payments/export?${q(accountId, filter)}`),
  staffTodayCounts: (accountId: string) =>
    fetchApi<Result<{ items: { staffId: string; todayCount: number }[]; date: string; timezone: string }>>(`/api/booking/admin/staff/today-counts?${q(accountId)}`),
  previewPaymentLink: (accountId: string, paymentId: string) =>
    fetchApi<Result<PaymentLinkPreview>>(`/api/booking/admin/payments/${encodeURIComponent(paymentId)}/send-link?${q(accountId)}`, { method: 'POST', body: JSON.stringify({ dryRun: true }) }),
  connection: (accountId: string) =>
    fetchApi<Result<StripeConnection>>(`/api/booking/admin/payment-connection?${q(accountId)}`),
  menuOverrides: (accountId: string) =>
    fetchApi<Result<{ menus: MenuPaymentOverride[] }>>(`/api/booking/admin/menu-payments?${q(accountId)}`),
  records: (accountId: string, filter: { q?: string; status?: string; method?: string; period?: string; limit?: number; offset?: number } = {}) =>
    fetchApi<Result<PaymentRecordsPage>>(`/api/booking/admin/payments?${q(accountId, filter)}`),
  events: (accountId: string, filter: { result?: string; period?: string; limit?: number } = {}) =>
    fetchApi<Result<{ items: PaymentEvent[]; total: number }>>(`/api/booking/admin/payment-events?${q(accountId, filter)}`),
  replayEvent: (accountId: string, id: string) =>
    fetchApi<Result<PaymentEvent>>(`/api/booking/admin/payment-events/${encodeURIComponent(id)}/replay?${q(accountId)}`, { method: 'POST', body: '{}' }),
  /** 同じ操作の再送には同じidempotencyKey。amount省略は残額全部。実送金・実送信なし。 */
  refund: (paymentId: string, input: RefundPaymentInput) =>
    fetchApi<Result<SimulatedPaymentResult & { payment: unknown; refund: PaymentRefund; duplicate: boolean }>>(`/api/booking/payments/${encodeURIComponent(paymentId)}/refund`, { method: 'POST', body: JSON.stringify(input) }),
  refunds: (paymentId: string) =>
    fetchApi<Result<{ items: PaymentRefund[] }>>(`/api/booking/payments/${encodeURIComponent(paymentId)}/refunds`),
  linkBooking: (paymentId: string, bookingId: string, reason: string) =>
    fetchApi<Result<{ payment: unknown }>>(`/api/booking/payments/${encodeURIComponent(paymentId)}/booking`, { method: 'POST', body: JSON.stringify({ bookingId, reason }) }),
  /** 飲食のコース（restaurant-test のメニュー）とイベントのクラスの支払い。予約メニューは bookingApi.saveMenuPayment。 */
  courseMode: (accountId: string, menuId: string) =>
    fetchApi<Result<{ mode: BookingPaymentMode | null; version: number }>>(`/api/restaurant-test/menus/${encodeURIComponent(menuId)}/payment?${q(accountId)}`),
  saveCourseMode: (accountId: string, menuId: string, mode: BookingPaymentMode | null, expectedVersion?: number) =>
    fetchApi<Result<{ mode: BookingPaymentMode | null; version: number }>>(`/api/restaurant-test/menus/${encodeURIComponent(menuId)}/payment?${q(accountId)}`, { method: 'PUT', body: JSON.stringify({ mode, expectedVersion }) }),
  eventMode: (accountId: string, eventId: string) =>
    fetchApi<Result<{ mode: BookingPaymentMode | null; version: number }>>(`/api/events/admin/events/${encodeURIComponent(eventId)}/payment?${q(accountId)}`),
  saveEventMode: (accountId: string, eventId: string, mode: BookingPaymentMode | null, expectedVersion?: number) =>
    fetchApi<Result<{ mode: BookingPaymentMode | null; version: number }>>(`/api/events/admin/events/${encodeURIComponent(eventId)}/payment?${q(accountId)}`, { method: 'PUT', body: JSON.stringify({ mode, expectedVersion }) }),
  eventPrice: (accountId: string, eventId: string) =>
    fetchApi<Result<{ unitPrice: number; version: number }>>(`/api/events/admin/events/${encodeURIComponent(eventId)}/price?${q(accountId)}`),
  saveEventPrice: (accountId: string, eventId: string, unitPrice: number, expectedVersion?: number) =>
    fetchApi<Result<{ unitPrice: number; version: number }>>(`/api/events/admin/events/${encodeURIComponent(eventId)}/price?${q(accountId)}`, { method: 'PUT', body: JSON.stringify({ unitPrice, expectedVersion }) }),
};

/** 口がまだ無い・表がまだ無い（ の「現在準備中です」で出す）か。 */
export function isNotReadyError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 405 || error.status === 501) return true;
  return error.status === 503 && /not_ready|storage/.test(error.code ?? '');
}
