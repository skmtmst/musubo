import { fetchApi } from './transport/request'
import type {
  ApiResponse,
  BookingConflictsResponse,
  BookingReassignInput,
  BookingCustomerNotification,
  BookingMenuReorderRequest,
  BookingMenuReorderResponse,
  BookingWaitlistSlotSummary,
  SeatWaitlistSlotSummary,
  CustomerSeatWaitlist,
} from '@line-crm/shared'
import type {
  BookingPaymentAdminConfig,
  BookingSalesSummary,
  BookingNoshowSettings,
  BookingPrepayDecision,
} from './types/booking-payments'
import type {
  BookingCustomerContext,
  BookingAdminDetail,
  UpdateBookingResult,
  BookingConflictAlternatives,
  BookingCustomerSummary,
  BookingSettings,
  SaveBookingSettings,
  BookingResource,
  BookingException,
  BookingMenu,
  BookingMenuWrite,
  BookingMenuStaff,
  BookingAvailabilityResponse,
  BookingAvailabilityBatchResponse,
  BookingSlotCheckResult,
  BookingNotificationPolicy,
  ProxyBookingResult,
  UpdateBookingInput,
  BookingSyncRetryResult,
  BookingNotificationRetryResult,
  BookingAuditLog,
  BookingMenuVersion,
  BookingStaff,
  StaffMenuMatrix,
  BookingShift,
  BookingAvailabilityRule,
  BookingBreaksResponse,
  BookingBreak,
  BookingDateBreaksResponse,
  BookingDateBreak,
  BookingGoogleCalendarConnection,
  BookingRequest,
  BookingTodayResponse,
  BookingWaitlistEntry,
  BookingVisitMark,
} from './types/booking'
import { downloadApiFile } from './transport/download'

export function withAccount(path: string, accountId: string): string {
  return `${path}${path.includes('?') ? '&' : '?'}account_id=${encodeURIComponent(accountId)}`;
}

export const bookingApi = {
  getChannels: (accountId: string) => fetchApi<ApiResponse<{
    timeZone: string; autoAssign: boolean;
    staff: Array<{ staffId: string; displayName: string; status: 'connected' | 'disconnected' | 'expired'; externalEventsThisWeek: number | null; lastReadAt: string | null; readError: string | null }>;
    channels: Array<{ key: string; status: string; todayCount: number | null; enabled?: boolean; version?: number; connectionStatus?: 'requested' | 'disabled'; operational?: false }>;
  }>>(withAccount('/api/booking/admin/channels', accountId)),
  /** 外部サービスの実接続ではなく、連携を希望する設定だけを保存する。 */
  saveChannelSetting: (accountId: string, channel: 'hot_pepper_beauty' | 'google_reserve' | 'epark', data: { enabled: boolean; expectedVersion: number }) =>
    fetchApi<ApiResponse<{ key: string; enabled: boolean; version: number; connectionStatus: 'requested' | 'disabled'; operational: false }>>(
      withAccount(`/api/booking/admin/channels/${channel}/settings`, accountId), { method: 'PUT', body: JSON.stringify(data) },
    ),
  getPaymentConfig: (accountId: string) =>
    fetchApi<{ success: true; data: BookingPaymentAdminConfig }>(
      withAccount('/api/booking/admin/payment-config', accountId),
    ),
  savePaymentConfig: (
    accountId: string,
    body: { mode: 'none' | 'onsite' | 'online' | 'customer_choice'; provider: 'none' | 'onsite' | 'stripe'; holdMinutes: number },
  ) =>
    fetchApi<{ success: true; data: BookingPaymentAdminConfig }>(
      withAccount('/api/booking/admin/payment-config', accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  saveMenuPayment: (
    accountId: string,
    menuId: string,
    body: { mode: 'none' | 'onsite' | 'online' | 'customer_choice'; provider: 'none' | 'onsite' | 'stripe' },
  ) =>
    fetchApi<{ success: true; data: BookingPaymentAdminConfig }>(
      withAccount(`/api/booking/admin/menus/${menuId}/payment`, accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  clearMenuPayment: (accountId: string, menuId: string) =>
    fetchApi<{ success: true; data: { cleared: boolean } }>(
      withAccount(`/api/booking/admin/menus/${menuId}/payment`, accountId),
      { method: 'DELETE' },
    ),
  getSalesSummary: (accountId: string, from: string, to: string) => {
    const params = new URLSearchParams({ account_id: accountId, from, to });
    return fetchApi<{ success: true; data: BookingSalesSummary }>(
      `/api/booking/admin/sales-summary?${params}`,
    );
  },
  getNoshowSettings: (accountId: string) =>
    fetchApi<{ success: true; data: BookingNoshowSettings }>(
      withAccount('/api/booking/admin/noshow-settings', accountId),
    ),
  saveNoshowSettings: (accountId: string, body: Partial<BookingNoshowSettings>) =>
    fetchApi<{ success: true; data: BookingNoshowSettings }>(
      withAccount('/api/booking/admin/noshow-settings', accountId),
      { method: 'PUT', body: JSON.stringify(body) },
    ),
  getFriendNoshow: (accountId: string, friendId: string) =>
    fetchApi<{ success: true; data: BookingPrepayDecision }>(
      withAccount(`/api/booking/admin/friends/${encodeURIComponent(friendId)}/noshow`, accountId),
    ),
  setFriendPrepay: (accountId: string, friendId: string, body: { mode: 'manual_on' | 'manual_off'; reason?: string }) =>
    fetchApi<{ success: true; data: BookingPrepayDecision }>(
      withAccount(`/api/booking/admin/friends/${encodeURIComponent(friendId)}/prepay`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  clearFriendPrepay: (accountId: string, friendId: string) =>
    fetchApi<{ success: true; data: BookingPrepayDecision }>(
      withAccount(`/api/booking/admin/friends/${encodeURIComponent(friendId)}/prepay`, accountId),
      { method: 'DELETE' },
    ),
  previewReminders: (accountId: string, startsAt: string) => {
    const params = new URLSearchParams({ account_id: accountId, starts_at: startsAt });
    return fetchApi<{ reminders: Array<{ kind: 'day_before' | 'hours_before'; scheduledAt: string }> }>(
      `/api/booking/admin/reminder-preview?${params}`,
    );
  },
  getCustomerContext: (
    accountId: string,
    input: { friendId?: string; bookingCustomerId?: string },
  ) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (input.friendId) params.set('friend_id', input.friendId);
    if (input.bookingCustomerId) params.set('booking_customer_id', input.bookingCustomerId);
    return fetchApi<{ customer: BookingCustomerContext }>(`/api/booking/admin/customer-context?${params}`);
  },
  getBooking: (accountId: string, id: string) =>
    fetchApi<{ booking: BookingAdminDetail }>(withAccount(`/api/booking/admin/bookings/${id}`, accountId)),
  /** 重なった2件の表示情報と理由、カレンダー連携の案内。 */
  getConflicts: (accountId: string) =>
    fetchApi<ApiResponse<BookingConflictsResponse>>(withAccount('/api/booking/admin/conflicts', accountId)),
  /** 既存の枠照合・変更通知を使う。LINE未連携なら電話連絡の案内が返る。 */
  reassignBooking: (accountId: string, id: string, body: BookingReassignInput) =>
    fetchApi<UpdateBookingResult & { customerNotification: BookingCustomerNotification }>(
      withAccount(`/api/booking/admin/bookings/${encodeURIComponent(id)}/reassign`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  getAlternatives: (
    accountId: string,
    input: { menuId: string; staffId: string; startsAt: string },
  ) => {
    const params = new URLSearchParams({
      account_id: accountId,
      menu_id: input.menuId,
      staff_id: input.staffId,
      starts_at: input.startsAt,
    });
    return fetchApi<BookingConflictAlternatives>(`/api/booking/admin/alternatives?${params}`);
  },
  listCustomers: (accountId: string, query?: string) => {
    const params = new URLSearchParams({ account_id: accountId });
    if (query?.trim()) params.set('q', query.trim());
    return fetchApi<{ customers: BookingCustomerSummary[] }>(`/api/booking/admin/customers?${params}`);
  },
  createCustomer: (
    accountId: string,
    body: { display_name: string; phone: string; pet_name?: string },
    idempotencyKey?: string,
  ) =>
    fetchApi<{ customer: BookingCustomerSummary }>(withAccount('/api/booking/admin/customers', accountId), {
      method: 'POST',
      // R559: 確定操作ごとに1つのキーで送り、応答消失後の再送で台帳を二重作成しない。
      ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      body: JSON.stringify(body),
    }),
  getSettings: (accountId: string) =>
    fetchApi<ApiResponse<BookingSettings>>(withAccount('/api/booking/admin/settings', accountId)),
  saveSettings: (accountId: string, body: SaveBookingSettings) =>
    fetchApi<ApiResponse<BookingSettings>>(withAccount('/api/booking/admin/settings', accountId), {
      method: 'PUT', body: JSON.stringify(body),
    }),
  listResources: (accountId: string) =>
    fetchApi<{ success: true; data: { resources: BookingResource[] } }>(
      withAccount('/api/booking/admin/resources', accountId),
    ),
  createResource: (accountId: string, body: {
    name: string; type: string; capacity: number; isActive?: boolean;
  }) => fetchApi<{ success: true; data: BookingResource }>(
    withAccount('/api/booking/admin/resources', accountId),
    { method: 'POST', body: JSON.stringify(body) },
  ),
  updateResource: (accountId: string, id: string, body: {
    expectedVersion: number; name?: string; type?: string; capacity?: number; isActive?: boolean;
  }) => fetchApi<{ success: true; data: BookingResource }>(
    withAccount(`/api/booking/admin/resources/${id}`, accountId),
    { method: 'PATCH', body: JSON.stringify(body) },
  ),
  deleteResource: (accountId: string, id: string, expectedVersion: number) =>
    fetchApi<{ success: true; data: { id: string } }>(
      withAccount(`/api/booking/admin/resources/${id}`, accountId),
      { method: 'DELETE', body: JSON.stringify({ expectedVersion }) },
    ),
  /** 例外日の一覧（store/staff/resource すべて）。 */
  listExceptions: (accountId: string) =>
    fetchApi<{ success: true; data: { items: BookingException[] } }>(
      withAccount('/api/booking/admin/exceptions', accountId),
    ),
  createException: (
    accountId: string,
    body: {
      scopeKind: 'store' | 'staff' | 'resource';
      scopeId?: string | null;
      dateFrom: string;
      dateTo: string;
      kind: 'open' | 'closed' | 'custom_hours';
      intervals: Array<{ start: string; end: string }>;
      reason: string | null;
    },
  ) => fetchApi<ApiResponse<BookingException>>(
    withAccount('/api/booking/admin/exceptions', accountId),
    { method: 'POST', body: JSON.stringify(body) },
  ),
  /** #953 E-09: 登録済みの例外日を画面から直す。送った項目だけが変わる。 */
  updateException: (
    accountId: string,
    id: string,
    body: {
      expectedVersion: number;
      scopeKind?: 'store' | 'staff' | 'resource';
      scopeId?: string | null;
      dateFrom?: string;
      dateTo?: string;
      kind?: 'open' | 'closed' | 'custom_hours';
      intervals?: Array<{ start: string; end: string }>;
      reason?: string | null;
    },
  ) => fetchApi<ApiResponse<BookingException>>(
    withAccount(`/api/booking/admin/exceptions/${encodeURIComponent(id)}`, accountId),
    { method: 'PATCH', body: JSON.stringify(body) },
  ),
  /** #953 E-09: 例外日を版付きで消す。古い版は 409 で止まる。 */
  deleteException: (accountId: string, id: string, expectedVersion: number) =>
    fetchApi<ApiResponse<{ id: string }>>(
      withAccount(`/api/booking/admin/exceptions/${encodeURIComponent(id)}`, accountId),
      { method: 'DELETE', body: JSON.stringify({ expectedVersion }) },
    ),
  // Menus
  listMenus: (accountId: string) =>
    fetchApi<{ menus: BookingMenu[] }>(withAccount('/api/booking/admin/menus', accountId)),
  listMenuStaff: (accountId: string, menuId: string) =>
    fetchApi<{ staff: BookingMenuStaff[] }>(
      withAccount(`/api/booking/admin/menus/${menuId}/staff`, accountId),
    ),
  getAvailability: (
    accountId: string,
    params: { menuId: string; staffId?: string; from: string; to: string; excludeBookingId?: string; applyStoreRules?: boolean },
  ) => {
    const query = new URLSearchParams({
      account_id: accountId,
      menu_id: params.menuId,
      from: params.from,
      to: params.to,
    });
    if (params.staffId) query.set('staff_id', params.staffId);
    if (params.excludeBookingId) query.set('exclude_booking_id', params.excludeBookingId);
    // (b): お客様の画面の見本だけ店舗ルールで判定する。付けない呼び出しは従来どおり。
    if (params.applyStoreRules) query.set('apply_store_rules', '1');
    return fetchApi<BookingAvailabilityResponse>(`/api/booking/admin/availability?${query}`);
  },
  /**
   * #1060: メニューごとの空き枠を1要求で取る一括口。
   * カレンダーがメニュー数ぶん往復していたのを1往復へまとめる。
   * 応答は `{ by_menu: [{ menu_id, by_staff, calendar_sync }] }`。
   */
  getAvailabilityBatch: (
    accountId: string,
    params: { menuIds: string[]; staffId?: string; from: string; to: string; excludeBookingId?: string },
  ) => {
    const query = new URLSearchParams({
      account_id: accountId,
      menu_ids: params.menuIds.join(','),
      from: params.from,
      to: params.to,
    });
    if (params.staffId) query.set('staff_id', params.staffId);
    if (params.excludeBookingId) query.set('exclude_booking_id', params.excludeBookingId);
    return fetchApi<BookingAvailabilityBatchResponse>(`/api/booking/admin/availability?${query}`);
  },
  /** IDEA-28: 指定した日時がなぜ予約できないかを確認する（読み取り専用・予約は作らない）。 */
  checkAvailability: (
    accountId: string,
    params: { menuId: string; staffId?: string; date: string; time: string },
  ) => {
    const query = new URLSearchParams({
      account_id: accountId,
      menu_id: params.menuId,
      date: params.date,
      time: params.time,
    });
    if (params.staffId) query.set('staff_id', params.staffId);
    return fetchApi<BookingSlotCheckResult>(`/api/booking/admin/availability-check?${query}`);
  },
  createProxyBooking: (
    accountId: string,
    body: {
      friend_id?: string;
      booking_customer_id?: string;
      menu_id: string;
      staff_id: string;
      starts_at: string;
      customer_note?: string;
      /** 確認メッセージを送るか（旧キー。notification_policy が優先）。 */
      send_line_confirmation?: boolean;
      /** N-391: 確認・前日・当日のお知らせを個別に切る。 */
      notification_policy?: Partial<BookingNotificationPolicy>;
    },
    idempotencyKey: string,
  ) =>
    fetchApi<ProxyBookingResult>(withAccount('/api/booking/admin/bookings', accountId), {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(body),
    }),
  /** N-389: 予約内容の変更。lock_version で楽観ロックする。 */
  updateBooking: (accountId: string, id: string, body: UpdateBookingInput) =>
    fetchApi<UpdateBookingResult>(withAccount(`/api/booking/admin/bookings/${id}`, accountId), {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  /** N-392: 失敗した Google 同期の手動再試行。 */
  retryCalendarSync: (accountId: string, id: string) =>
    fetchApi<BookingSyncRetryResult>(withAccount(`/api/booking/admin/bookings/${id}/sync/retry`, accountId), {
      method: 'POST', body: '{}',
    }),
  /** N-393: 失敗した LINE 通知の手動再試行。runId は operations 行の id。 */
  retryNotification: (accountId: string, id: string, runId: string) =>
    fetchApi<BookingNotificationRetryResult>(
      withAccount(`/api/booking/admin/bookings/${id}/notifications/${runId}/retry`, accountId),
      { method: 'POST', body: '{}' },
    ),
  /** N-394: 変更履歴の取得（detail 応答にも auditLogs として同梱される）。 */
  getAuditLogs: (accountId: string, id: string, limit = 100) =>
    fetchApi<{ audit_logs: BookingAuditLog[] }>(
      withAccount(`/api/booking/admin/bookings/${id}/audit-logs`, accountId) + `&limit=${limit}`,
    ),
  /**
   * R535: 作成試行ごとの一意キーを送る。サーバーで保存された直後に
   * 応答だけを失っても、同じキーでの再送は作り直さず作成済みIDを返す。
   * キーが無い呼び出しは従来どおり毎回作成する。
   */
  createMenu: (accountId: string, body: BookingMenuWrite, idempotencyKey?: string) =>
    fetchApi<{ id: string }>(withAccount('/api/booking/admin/menus', accountId), {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : undefined,
      body: JSON.stringify(body),
    }),
  reorderMenus: (accountId: string, body: BookingMenuReorderRequest) =>
    fetchApi<BookingMenuReorderResponse>(withAccount('/api/booking/admin/menus/order', accountId), {
      method: 'PUT', body: JSON.stringify(body),
    }),
  updateMenu: (accountId: string, id: string, expectedVersion: number, body: BookingMenuWrite) =>
    fetchApi<{ ok: true; version: number }>(withAccount(`/api/booking/admin/menus/${id}`, accountId), {
      method: 'PUT',
      body: JSON.stringify({ ...body, expectedVersion }),
    }),
  /** T: 版の履歴。新しい順。いちばん新しい版だけ status が in_use。 */
  listMenuVersions: (accountId: string, id: string) =>
    fetchApi<{ versions: BookingMenuVersion[] }>(
      withAccount(`/api/booking/admin/menus/${id}/versions`, accountId),
    ),
  /** T: 版の中身。比べる画面に行の一覧で返す。 */
  getMenuVersion: (accountId: string, id: string, version: number) =>
    fetchApi<{ version: BookingMenuVersion }>(
      withAccount(`/api/booking/admin/menus/${id}/versions/${version}`, accountId),
    ),
  /** T: この版に戻す。昔の版は変えず、その中身で新しい版を作る。 */
  revertMenuVersion: (accountId: string, id: string, version: number, expectedVersion: number) =>
    fetchApi<{ ok: true; version: number }>(
      withAccount(`/api/booking/admin/menus/${id}/versions/${version}/revert`, accountId),
      { method: 'POST', body: JSON.stringify({ expectedVersion }) },
    ),
  saveMenuResources: (
    accountId: string,
    id: string,
    body: { expectedVersion: number; resources: Array<{ resourceId: string; quantity: number }> },
  ) => fetchApi<{
    success: true;
    data: { id: string; version: number; resources: Array<{ resourceId: string; quantity: number }> };
  }>(withAccount(`/api/booking/admin/menus/${id}/resources`, accountId), {
    method: 'PUT', body: JSON.stringify(body),
  }),
  patchMenu: (
    accountId: string,
    id: string,
    expectedVersion: number,
    body: { is_active?: boolean },
  ) => fetchApi<{ success: true; data: { id: string; version: number } }>(
    withAccount(`/api/booking/admin/menus/${id}`, accountId),
    { method: 'PATCH', body: JSON.stringify({ ...body, expectedVersion }) },
  ),
  deleteMenu: (accountId: string, id: string) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/menus/${id}`, accountId), {
      method: 'DELETE',
    }),
  // Staff
  listStaff: (accountId: string) =>
    fetchApi<{ staff: BookingStaff[] }>(withAccount('/api/booking/admin/staff', accountId)),
  // N-411: 自分に紐づく予約スタッフ。本人勤務の画面が自分のレコードを特定するために使う。
  listMyStaff: (accountId?: string) =>
    fetchApi<{ staff: BookingStaff[] }>(
      accountId ? withAccount('/api/booking/admin/staff/me', accountId) : '/api/booking/admin/staff/me',
    ),
  createStaff: (accountId: string, body: Partial<BookingStaff>) =>
    fetchApi<{ id: string }>(withAccount('/api/booking/admin/staff', accountId), {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateStaff: (accountId: string, id: string, body: Partial<BookingStaff>) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/staff/${id}`, accountId), {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteStaff: (accountId: string, id: string) =>
    fetchApi<{ ok: true }>(withAccount(`/api/booking/admin/staff/${id}`, accountId), {
      method: 'DELETE',
    }),
  // staff_menus matrix
  getStaffMenus: (accountId: string, staffId: string) =>
    fetchApi<{ matrix: StaffMenuMatrix[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/menus`, accountId),
    ),
  /**
   * #1060: 全スタッフ分の割り当て表を1要求で読む一括口。
   * マトリクス画面がスタッフ数ぶん往復していたのを1往復へまとめる。
   * 応答は一括PUTと同じ `{ staff: [{ staff_id, matrix }] }` の形。
   */
  listStaffMenusBulk: (accountId: string) =>
    fetchApi<{ staff: Array<{ staff_id: string; matrix: StaffMenuMatrix[] }> }>(
      withAccount('/api/booking/admin/staff-menus', accountId),
    ),
  putStaffMenus: (
    accountId: string,
    staffId: string,
    menus: Array<{
      menu_id: string;
      is_offered: boolean;
      override_duration_minutes?: number | null;
      override_price?: number | null;
    }>,
  ) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/booking/admin/staff/${staffId}/menus`, accountId),
      { method: 'PUT', body: JSON.stringify({ menus }) },
    ),
  // 全スタッフ分を1要求で保存する一括口。全件成功または全件不適用。
  putStaffMenusBulk: (
    accountId: string,
    staff: Array<{
      staff_id: string;
      menus: Array<{
        menu_id: string;
        is_offered: boolean;
        override_duration_minutes?: number | null;
        override_price?: number | null;
      }>;
    }>,
  ) =>
    fetchApi<{ ok: true }>(withAccount('/api/booking/admin/staff-menus', accountId), {
      method: 'PUT',
      body: JSON.stringify({ staff }),
    }),
  // Shifts
  getShifts: (accountId: string, staffId: string) =>
    fetchApi<{ shifts: BookingShift[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts`, accountId),
    ),
  putShifts: (
    accountId: string,
    staffId: string,
    shifts: Array<{ work_date: string; start_time: string; end_time: string; is_responsible?: boolean }>,
  ) =>
    fetchApi<{ ok: true; count: number }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts`, accountId),
      { method: 'PUT', body: JSON.stringify({ shifts }) },
    ),
  deleteShift: (accountId: string, staffId: string, shiftId: string) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts/${shiftId}`, accountId),
      { method: 'DELETE' },
    ),
  generateShifts: (
    accountId: string,
    staffId: string,
    body: {
      from_date: string;
      weeks: number;
      weekly_template: Record<string, { start: string; end: string } | null>;
    },
  ) =>
    fetchApi<{ inserted: number }>(
      withAccount(`/api/booking/admin/staff/${staffId}/shifts/generate`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  getAvailabilityRules: (accountId: string, staffId: string) =>
    fetchApi<{ rules: BookingAvailabilityRule[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/availability-rules`, accountId),
    ),
  putAvailabilityRules: (
    accountId: string,
    staffId: string,
    rules: Array<{ weekday: number; start_time: string; end_time: string }>,
  ) =>
    fetchApi<{ ok: true; count: number }>(
      withAccount(`/api/booking/admin/staff/${staffId}/availability-rules`, accountId),
      { method: 'PUT', body: JSON.stringify({ rules }) },
    ),
  getBreaks: (accountId: string, staffId: string) =>
    fetchApi<BookingBreaksResponse>(
      withAccount(`/api/booking/admin/staff/${staffId}/breaks`, accountId),
    ),
  putBreaks: (
    accountId: string,
    staffId: string,
    expectedVersion: string,
    breaks: Array<{ id?: string; weekday: number; start_time: string; end_time: string }>,
  ) =>
    fetchApi<{ ok: true; count: number; version: string; breaks: BookingBreak[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/breaks`, accountId),
      { method: 'PUT', body: JSON.stringify({ expectedVersion, breaks }) },
    ),
  getBreakDates: (accountId: string, staffId: string) =>
    fetchApi<BookingDateBreaksResponse>(
      withAccount(`/api/booking/admin/staff/${staffId}/break-dates`, accountId),
    ),
  putBreakDates: (
    accountId: string,
    staffId: string,
    expectedVersion: string,
    breaks: Array<{ id?: string; work_date: string; start_time: string; end_time: string }>,
  ) =>
    fetchApi<{ ok: true; count: number; version: string; breaks: BookingDateBreak[] }>(
      withAccount(`/api/booking/admin/staff/${staffId}/break-dates`, accountId),
      { method: 'PUT', body: JSON.stringify({ expectedVersion, breaks }) },
    ),
  getGoogleCalendar: (accountId: string, staffId: string) =>
    fetchApi<{
      connection: BookingGoogleCalendarConnection | null;
      service_account: { configured: boolean; email: string | null };
    }>(withAccount(`/api/booking/admin/staff/${staffId}/google-calendar`, accountId)),
  putGoogleCalendar: (accountId: string, staffId: string, calendarId: string) =>
    fetchApi<{ ok: true; calendar_id: string; last_verified_at: string }>(
      withAccount(`/api/booking/admin/staff/${staffId}/google-calendar`, accountId),
      { method: 'PUT', body: JSON.stringify({ calendar_id: calendarId }) },
    ),
  deleteGoogleCalendar: (accountId: string, staffId: string) =>
    fetchApi<{ ok: true }>(
      withAccount(`/api/booking/admin/staff/${staffId}/google-calendar`, accountId),
      { method: 'DELETE' },
    ),
  // Requests
  listRequests: (accountId: string, status: string = 'requested', params?: {
    limit?: number
    offset?: number
    query?: string
    menuName?: string
    staffId?: string
    source?: string
    from?: string
    to?: string
  }) => {
    const query = new URLSearchParams({ status })
    if (params?.limit) query.set('limit', String(params.limit))
    if (params?.offset) query.set('offset', String(params.offset))
    if (params?.query) query.set('query', params.query)
    if (params?.menuName) query.set('menu_name', params.menuName)
    if (params?.staffId) query.set('staff_id', params.staffId)
    if (params?.source) query.set('source', params.source)
    if (params?.from) query.set('from', params.from)
    if (params?.to) query.set('to', params.to)
    return fetchApi<{ requests: BookingRequest[]; total: number }>(
      withAccount(`/api/booking/admin/requests?${query.toString()}`, accountId),
    )
  },
  /**
   * 予約台帳CSVの書出しURL (#933 N-397)。一覧と同じ絞り込みをそのまま受ける。
   * サーバ側は最大5000件までで、範囲の断りはCSV先頭の注記行に入る。
   */
  /**
   * 予約台帳CSV（N-397）。`<a href>` の直開きは Cookie にしか頼れず、
   * Cookie が届かない認証経路（cross-site の Bearer 補完など）では
   * 401 になってファイルが出ない。認証付きの取得で保存へ揃える（TECH-03）。
   * ファイル名はサーバーの Content-Disposition が決める。
   */
  downloadLedgerCsv: (accountId: string, params?: {
    status?: string
    query?: string
    menuName?: string
    staffId?: string
    source?: string
    from?: string
    to?: string
  }) => {
    const query = new URLSearchParams()
    if (params?.status) query.set('status', params.status)
    if (params?.query) query.set('query', params.query)
    if (params?.menuName) query.set('menu_name', params.menuName)
    if (params?.staffId) query.set('staff_id', params.staffId)
    if (params?.source) query.set('source', params.source)
    if (params?.from) query.set('from', params.from)
    if (params?.to) query.set('to', params.to)
    const suffix = query.toString() ? `&${query.toString()}` : ''
    return downloadApiFile(
      `/api/booking/admin/bookings.csv?account_id=${encodeURIComponent(accountId)}${suffix}`,
      'booking-ledger.csv',
    )
  },
  requestsSummary: (accountId: string, params: {
    month: string
    lastMonth: string
    today: string
    weekTo: string
  }) => {
    const query = new URLSearchParams({
      month: params.month,
      last_month: params.lastMonth,
      today: params.today,
      week_to: params.weekTo,
    })
    return fetchApi<{
      total: number
      requested: number
      monthTotal: number
      monthConfirmed: number
      monthCancelled: number
      lastMonthTotal: number
      todayTotal: number
      /**
       * 取消・完了・無断を除いた「今日対応する予約」の総数（A01-04）。
       * 明細取得の上限100件に引っ張られない。段階配備中の旧Workerでは未返却。
       */
      todayActiveTotal?: number
      weekTotal: number
      /**
       * 表示タブ（今日・今週・今月）の数。取消・拒否・期限切れを除いた
       * 有効な予約だけ（カレンダーと同じ基準）。段階配備中の旧Workerでは未返却。
       */
      todayTabTotal?: number
      weekTabTotal?: number
      monthTabTotal?: number
      byMenu: Array<{ name: string; total: number }>
    }>(withAccount(`/api/booking/admin/requests-summary?${query.toString()}`, accountId))
  },
  decideRequest: (
    accountId: string,
    id: string,
    action: 'approve' | 'reject' | 'cancel' | 'no_show' | 'complete',
    expectedConfirmationRevision?: number,
  ) =>
    fetchApi<{ status: string }>(
      withAccount(`/api/booking/admin/requests/${id}`, accountId),
      { method: 'PATCH', body: JSON.stringify({ action, ...(expectedConfirmationRevision === undefined ? {} : { expectedConfirmationRevision }) }) },
    ),
  pendingCount: (accountId: string) =>
    fetchApi<{ count: number }>(withAccount('/api/booking/admin/pending-count', accountId)),
  /**
   * 今日の予約（booking-plus 6）。その日の予約を時刻順に返す。
   * mode=staff（人）・seat（席）・both（両方を1本に混ぜる）。
   * from/to で期間も取れる（週・月用）。
   */
  getToday: (
    accountId: string,
    params: {
      date?: string
      from?: string
      to?: string
      mode?: 'staff' | 'seat' | 'both'
      staffId?: string
      storeId?: string
      status?: string
    } = {},
  ) => {
    const query = new URLSearchParams()
    if (params.date) query.set('date', params.date)
    if (params.from) query.set('from', params.from)
    if (params.to) query.set('to', params.to)
    if (params.mode) query.set('mode', params.mode)
    if (params.staffId) query.set('staff_id', params.staffId)
    if (params.storeId) query.set('store_id', params.storeId)
    if (params.status) query.set('status', params.status)
    return fetchApi<BookingTodayResponse>(
      withAccount(`/api/booking/admin/today?${query.toString()}`, accountId),
    )
  },
  /** キャンセル待ちの一覧（booking-plus 2）。 */
  listWaitlist: (
    accountId: string,
    params: { staffId?: string; startsAt?: string; status?: string } = {},
  ) => {
    const query = new URLSearchParams()
    if (params.staffId) query.set('staff_id', params.staffId)
    if (params.startsAt) query.set('starts_at', params.startsAt)
    if (params.status) query.set('status', params.status)
    return fetchApi<{ waitlist: BookingWaitlistEntry[];slots:BookingWaitlistSlotSummary[];seatSlots:SeatWaitlistSlotSummary[];seatWaitlist:CustomerSeatWaitlist[] }>(
      withAccount(`/api/booking/admin/waitlist?${query.toString()}`, accountId),
    )
  },
  cancelWaitlist:(accountId:string,id:string,kind:'staff'|'seat'='staff')=>fetchApi<{status:'cancelled'}>(withAccount(`/api/booking/admin/waitlist/${encodeURIComponent(id)}?kind=${kind}`,accountId),{method:'DELETE'}),
  /** 今日の予約に印を付ける（来店した・遅れる・来なかった）。 */
  postVisitMark: (
    accountId: string,
    bookingId: string,
    body: { kind: 'visited' | 'late' | 'no_show'; late_minutes?: number },
  ) =>
    fetchApi<{ status: string; visit_mark: BookingVisitMark }>(
      withAccount(`/api/booking/admin/bookings/${bookingId}/visit`, accountId),
      { method: 'POST', body: JSON.stringify(body) },
    ),
  /** 今日の予約の印を取り消す（元に戻す）。 */
  deleteVisitMark: (accountId: string, bookingId: string) =>
    fetchApi<{ status: string }>(
      withAccount(`/api/booking/admin/bookings/${bookingId}/visit`, accountId),
      { method: 'DELETE' },
    ),
};
