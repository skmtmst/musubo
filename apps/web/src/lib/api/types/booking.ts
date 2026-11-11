import type { BookingAudienceWrite } from '@line-crm/shared'

// ----------------------------------------------------------------
// Booking API client (admin endpoints scoped by ?account_id=)
// ----------------------------------------------------------------

export interface BookingMenu {
  id: string;
  name: string;
  category_label: string | null;
  description: string | null;
  duration_minutes: number;
  buffer_after_minutes: number;
  base_price: number;
  price_mode?: 'fixed' | 'free' | 'inquiry';
  version?: number;
  sort_order: number;
  is_active: number;
  auto_tag_id: string | null;
  /** 同じ時間帯に受けられる件数。1 なら重ねない（従来どおり） */
  concurrent_capacity?: number;
  /** 何日先まで予約を受けるか。null なら制限なし */
  booking_window_days?: number | null;
  /** 開始の何時間前で締め切るか。null なら直前まで受ける */
  cutoff_hours_before?: number | null;
  /** 開始の何時間前までキャンセルできるか。null なら制限なし */
  cancel_deadline_hours_before?: number | null;
  /** 予約時にお客様へ聞く質問。null なら質問しない */
  intake_question?: string | null;
  /** 一覧と同じ応答で返す担当。メニュー件数ぶんの追加通信をしない。 */
  assigned_staff?: Array<{ id: string; display_name: string }>;
  /** 1予約で消費する共有設備。停止済みも警告表示のため残して返す。 */
  assigned_resources?: BookingMenuResourceAssignment[];
  /** 個人情報を含む予約明細ではなく、Workerで集計した直近30日の件数。 */
  booking_count_30_days?: number;
  effectiveBookingRules?: {
    bookingWindowDays: number;
    cutoffMinutesBefore: number;
    cancelDeadlineMinutesBefore: number;
    source: {
      bookingWindowDays: 'store' | 'menu';
      cutoffMinutesBefore: 'store' | 'menu';
      cancelDeadlineMinutesBefore: 'store' | 'menu';
    };
  };
}

export interface BookingMenuResourceAssignment {
  menuId: string;
  resourceId: string;
  name: string;
  type: string;
  capacity: number;
  quantity: number;
  isActive: boolean;
  warning: 'resource_inactive' | 'capacity_exceeded' | null;
}

/** 読み取りの列名と、APIへ送るタグ条件の項目名を区別する。 */
export type BookingMenuWrite = Partial<BookingMenu> & Partial<Pick<BookingAudienceWrite, 'audienceMode' | 'audienceTagIds'>>

/** T: 予約メニューの版。いちばん新しい版だけ status が in_use。 */
export interface BookingMenuVersion {
  version_number: number;
  title: string;
  status: 'in_use' | 'past';
  summary: string;
  author: string | null;
  at: string;
  lines: string[];
}

/** T: 予約の写し。予約した時点の内容（値段・時間）。無い予約は null。 */
export interface BookingMenuSnapshot {
  version: number;
  name: string;
  durationMinutes: number;
  bufferAfterMinutes: number;
  basePrice: number;
  priceMode: string;
}

export interface BookingException {
  id: string;
  lineAccountId: string;
  scopeKind: 'store' | 'staff' | 'resource';
  scopeId: string | null;
  date: string | null;
  dateFrom: string;
  dateTo: string;
  kind: 'open' | 'closed' | 'custom_hours';
  intervals: Array<{ start: string; end: string }>;
  reason: string | null;
  note: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface BookingSettings {
  id: string | null;
  lineAccountId: string;
  organizationName: string;
  version: number;
  timeZone: string;
  bookingWindowDays: number;
  cutoffMinutesBefore: number;
  cancelDeadlineMinutesBefore: number;
  maxActiveBookingsPerFriend: number;
  approvalMode: 'automatic' | 'manual';
  holdMinutes: number;
  /** キャンセル待ちの仮押さえ分数。古い応答では無いことがある。 */
  waitlistHoldMinutes?: number;
  slotGranularityMinutes: 5 | 10 | 15 | 30 | 60;
  /** LIFF 予約「日時を選ぶ」段の最初の形。 */
  liffDateView: 'list' | 'calendar';
  /** 前日お知らせの送信時刻（店舗タイムゾーン）。null は予約24時間前。 */
  reminderDayBeforeTime: string | null;
  /** 当日お知らせを開始の何時間前に送るか。 */
  reminderHoursBefore: number;
  menuCount: number;
  activeMenuCount: number;
  inactiveMenuCount: number;
  businessHoursConfigured: boolean;
  openingHoursSource?: 'manual' | 'google_business' | 'google_unavailable';
  businessHours: Array<{
    weekday: number;
    intervals: Array<{ start: string; end: string; capacity?: number }>;
  }>;
  exceptions: BookingException[];
  updatedAt: string;
}

export type SaveBookingSettings = Pick<
  BookingSettings,
  | 'timeZone'
  | 'bookingWindowDays'
  | 'cutoffMinutesBefore'
  | 'cancelDeadlineMinutesBefore'
  | 'maxActiveBookingsPerFriend'
  | 'approvalMode'
  | 'holdMinutes'
  | 'slotGranularityMinutes'
> & {
  expectedVersion: number;
  /** LIFF 予約「日時を選ぶ」段の最初の形。省いたら今の値を保つ。 */
  liffDateView?: 'list' | 'calendar';
  /** 前日お知らせの送信時刻（HH:MM）。null で従来の24時間前。 */
  reminderDayBeforeTime: string | null;
  /** 当日お知らせを何時間前に送るか（1〜72）。null で従来の2時間前。 */
  reminderHoursBefore: number | null;
  businessHours?: BookingSettings['businessHours'];
};

export interface BookingStaff {
  id: string;
  name: string;
  display_name: string;
  role: string | null;
  profile_image_url: string | null;
  bio: string | null;
  sort_order: number;
  is_designation_optional: number;
  is_active: number;
  /** N-411: 本人勤務の対象となるログインユーザー。 */
  staff_member_id?: string | null;
  /** お客さまが指名したときだけ足す料金（円）。 */
  nomination_fee?: number;
}

export interface BookingMenuStaff {
  id: string;
  display_name: string;
  role: string | null;
  profile_image_url: string | null;
  bio: string | null;
  is_designation_optional: number;
  price: number;
  duration_minutes: number;
}

export interface BookingShift {
  id: string;
  work_date: string;
  start_time: string;
  end_time: string;
  is_responsible?: number;
}

export interface StaffMenuMatrix {
  menu_id: string;
  name: string;
  is_offered: number;
  override_duration_minutes: number | null;
  override_price: number | null;
}

export interface BookingRequest {
  id: string;
  friend_id: string | null;
  booking_customer_id: string | null;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_note: string | null;
  internal_note: string | null;
  price_at_booking: number;
  menu_name: string;
  staff_name: string;
  friend_name: string | null;
  // 一覧 API は `SELECT b.*` なので bookings の全列が返る。詳細パネルで使う分だけ
  // 型に足す。internal_note / decided_by_staff_id は列こそあるが書き込み経路が
  // ないため、常に null になる。表示すると「いつまでも空欄」に見えるので出さない。
  requested_at: string;
  decided_at: string | null;
  external_event_id: string | null;
  /** 担当者・種別の絞り込み用 (#933 N-398)。`SELECT b.*` で返る実列。 */
  staff_id: string;
  source: 'liff' | 'phone' | 'counter' | 'operator' | 'import';
}

export interface BookingAvailabilityRule {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  is_active: number;
}

/** 今日の予約の印（booking-plus 6）。だれがいつ付けたか。 */
export interface BookingVisitMark {
  id?: string;
  kind: 'visited' | 'late' | 'no_show';
  late_minutes: number | null;
  marked_by_name: string | null;
  marked_at: string;
}

/** 今日の予約の人（スタッフ）の行。 */
export interface BookingTodayStaffRow {
  line_account_id?: string;
  lock_version?: number;
  kind: 'staff';
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  price_at_booking: number;
  friend_id: string | null;
  booking_customer_id: string | null;
  menu_id: string;
  menu_name: string;
  staff_id: string;
  staff_name: string;
  customer_name: string | null;
  visit_mark: BookingVisitMark | null;
}

/** 今日の予約の席（卓）の行。 */
export interface BookingTodaySeatRow {
  customer_version?: number;
  table_id?: string | null;
  table_ids_json?: string;
  source?: string;
  kind: 'seat';
  id: string;
  store_id: string;
  store_name: string;
  starts_at: string;
  ends_at: string;
  status: string;
  customer_name: string;
  guest_count: number;
  table_label: string | null;
  course_name: string | null;
  visit_mark: BookingVisitMark | null;
}

export type BookingTodayRow = BookingTodayStaffRow | BookingTodaySeatRow;

/** 今日の予約の一覧（booking-plus 6）。 */
export interface BookingTodayResponse {
  date: string;
  mode: 'staff' | 'seat' | 'both';
  /** 席の切り替えを出すか（結び付きのある店だけ）。 */
  has_seat_stores: boolean;
  bookings: BookingTodayStaffRow[];
  seats: BookingTodaySeatRow[];
  /** 人と席を1本に混ぜた時刻順（両方用）。 */
  timeline: BookingTodayRow[];
}

/** キャンセル待ちの1件（booking-plus 2）。 */
export interface BookingWaitlistEntry {
  position?: number | null
  id: string;
  staff_id: string;
  menu_id: string;
  starts_at: string;
  friend_id: string | null;
  booking_customer_id: string | null;
  status: 'waiting' | 'invited' | 'converted' | 'cancelled'|'finished';
  hold_minutes: number;
  invited_at: string | null;
  hold_expires_at: string | null;
  notified_at: string | null;
  created_at: string;
  menu_name?: string;
  staff_name?: string;
  customer_name?: string | null;
}

export interface BookingBreak {
  id: string;
  weekday: number;
  start_time: string;
  end_time: string;
  time_zone: string;
}

export interface BookingDateBreak {
  id: string;
  work_date: string;
  start_time: string;
  end_time: string;
  time_zone: string;
  start_utc_offset: string;
  end_utc_offset: string;
}

export interface BookingBreaksResponse {
  breaks: BookingBreak[];
  version: string;
}

export interface BookingDateBreaksResponse {
  breaks: BookingDateBreak[];
  version: string;
}

export interface BookingBreakConflict {
  version: string;
  breaks: Array<{ id: string; weekday?: number; work_date?: string; start_time: string; end_time: string }>;
}

export interface BookingGoogleCalendarConnection {
  id: string;
  calendar_id: string;
  auth_type: string;
  is_active: number;
  last_verified_at: string | null;
  last_error: string | null;
}

export interface BookingAvailabilitySlot {
  date: string;
  start: string;
  end: string;
  /** 店舗タイムゾーン名。表示・送信はこの zone で読む。 */
  timeZone: string;
  /** 開始 instant（offset 付き ISO。fold 日の重複壁時刻も一意になる）。 */
  startUtc: string;
  /** 終了 instant（開始＋所要分。offset 付き ISO）。 */
  endUtc: string;
  capacity: number;
  remaining: number;
  state: 'available' | 'limited' | 'full' | 'closed';
}

export interface BookingResource {
  id: string;
  lineAccountId: string;
  name: string;
  type: string;
  capacity: number;
  isActive: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  usage: {
    menuCount: number;
    bookingCount: number;
    exceptionCount: number;
    referenced: boolean;
  };
  businessHours: Array<{ start: string; end: string; capacity?: number }>;
  exceptions: BookingException[];
}

export interface BookingAvailabilityResponse {
  by_staff: Array<{
    staff_id: string;
    display_name: string;
    slots: BookingAvailabilitySlot[];
  }>;
  /** 休みの日（お店・担当が閉めている日）。LIFFプレビューの「休」の印に使う。 */
  closed_dates?: string[];
}

/** #1060: `menu_ids` 一括モードの応答。各要素は単独応答へ menu_id を添えた形。 */
export interface BookingAvailabilityBatchResponse {
  by_menu: Array<{ menu_id: string } & BookingAvailabilityResponse>;
}

/** IDEA-28 予約設定の「この日時はなぜ予約できないか」の理由コード。 */
export type BookingSlotBlockReason =
  | 'menu_inactive'
  | 'staff_not_offered'
  | 'invalid_resource'
  | 'booking_window'
  | 'past_cutoff'
  | 'invalid_time'
  | 'not_on_grid'
  | 'exception_closed'
  | 'exception_invalid'
  | 'outside_working'
  | 'duration_overrun'
  | 'other_booking'
  | 'google_busy'
  | 'capacity_full'
  | 'store_full'
  | 'resource_shortage'
  | 'calendar_unavailable'
  | 'unavailable';

export interface BookingSlotCheckStaff {
  staff_id: string;
  display_name: string;
  bookable: boolean;
  remaining: number | null;
  capacity: number | null;
  reasons: BookingSlotBlockReason[];
}

export interface BookingSlotCheckResult {
  date: string;
  time: string;
  timeZone: string;
  bookable: boolean;
  reasons: BookingSlotBlockReason[];
  per_staff: BookingSlotCheckStaff[];
  /** R314: 判定に実際に使った枠間隔（分）。無い応答では刻み幅を書かない文言にする。 */
  slotGranularityMinutes?: number;
}

export interface ProxyBookingResult {
  booking_id: string;
  status: string;
  calendar_sync: 'not_configured' | 'synced' | 'failed' | 'pending';
  // 再送時は裏側が 'scheduled' を返す(booking.ts)。無いと完了画面の文言が既定に落ちる。
  line_notification: 'queued' | 'scheduled' | 'succeeded' | 'failed' | 'not_applicable';
  reminders: BookingReminderResult[];
  operations: BookingOperationResult[];
  customer_context: BookingCustomerContext | null;
  replayed?: boolean;
}

export interface BookingReminderResult {
  id: string;
  kind: 'day_before' | 'hours_before';
  scheduled_at: string;
  sent_at: string | null;
  status: 'pending' | 'sent' | 'failed' | 'failed_permanent' | 'cancelled';
}

export interface BookingOperationResult {
  id: string;
  kind: 'confirmation_line' | 'google_calendar' | 'conversion' | 'mileage' | 'automation';
  status: 'queued' | 'succeeded' | 'skipped' | 'retry_wait' | 'permanent_failed' | 'cancelled';
  scheduledAt: string | null;
  completedAt: string | null;
  openedAt: string | null;
  result: Record<string, unknown>;
  errorCode: string | null;
}

export interface BookingHistorySummary {
  id: string;
  startsAt: string;
  status: string;
  customerNote: string | null;
  handoverNote: string | null;
  price: number;
  menuName: string;
  staffName: string;
}

/**
 * R320: 前回来店の申し送りの元予約。過去の来店完了だけを指す。
 * 日時・状態と一緒に表示し、元予約への入口にする。
 */
export interface BookingHandoverRef {
  id: string;
  startsAt: string;
  status: string;
}

export interface BookingCustomerContext {
  id: string;
  friendId: string | null;
  displayName: string;
  isLineLinked: boolean;
  phone: string | null;
  petName: string | null;
  tags: Array<{ id: string; name: string }>;
  mileageBalance: number | null;
  previousHandover: string | null;
  previousHandoverBooking: BookingHandoverRef | null;
  recentBookings: BookingHistorySummary[];
}

/** 予約ごとに固定される通知方針（作成・変更で確定する）。 */
export interface BookingNotificationPolicy {
  send_line_confirmation: boolean;
  day_before: boolean;
  hours_before: boolean;
}

/** 予約の変更履歴1件（append-only）。 */
export interface BookingAuditLog {
  id: string;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  actorType: 'customer' | 'staff' | 'system';
  actorId: string | null;
  actorName: string | null;
  occurredAt: string;
}

export interface BookingAdminDetail {
  id: string;
  staffId: string;
  menuId: string;
  /** 楽観ロックの現在版。PATCH にはこの値を送る。 */
  lockVersion: number;
  startsAt: string;
  endsAt: string;
  status: string;
  customerNote: string | null;
  internalNote: string | null;
  price: number;
  requestedAt: string;
  decidedAt: string | null;
  source: string;
  createdByStaffId: string | null;
  calendarSync: 'synced' | 'not_configured' | 'failed' | 'pending';
  /** この予約へ送る通知の固定方針。アカウント設定の現行値ではない。 */
  notificationPolicy: BookingNotificationPolicy;
  /** Workerの実送信と同じ文面。取得するだけでは送信・予定作成を行わない。 */
  confirmationPreviewText?: string | null;
  menuName: string;
  staffName: string;
  /** T: 予約の写し。写しが無い予約（490 より前）は null。 */
  menuSnapshot?: BookingMenuSnapshot | null;
  customer: {
    friendId: string | null;
    bookingCustomerId: string | null;
    displayName: string;
    isLineLinked: boolean;
    phone: string | null;
    petName: string | null;
    tags: Array<{ id: string; name: string }>;
    mileageBalance: number | null;
  };
  previousHandover: string | null;
  previousHandoverBooking: BookingHandoverRef | null;
  history: BookingHistorySummary[];
  /** R321: 同じ顧客の予約総数（この予約を除く）。history は直近10件だけ。 */
  historyTotal: number;
  reminders: Array<{
    id: string;
    kind: string;
    scheduledAt: string;
    sentAt: string | null;
    status: string;
    retryCount: number;
  }>;
  operations: BookingOperationResult[];
  /** 変更履歴の総数。auditLogs は直近の要点分だけ。残りは getAuditLogs で追加取得する。 */
  auditLogTotal: number;
  auditLogs: BookingAuditLog[];
}

/** PATCH /bookings/:id の入力。lock_version は detail.lockVersion から送る。 */
export interface UpdateBookingInput {
  lock_version: number;
  menu_id?: string;
  staff_id?: string;
  starts_at?: string;
  price?: number;
  customer_note?: string | null;
  internal_note?: string | null;
  notification_policy?: Partial<BookingNotificationPolicy>;
  send_change_notification?: boolean;
  reason?: string;
}

export interface UpdateBookingResult {
  booking_id: string;
  lock_version: number;
  status: string;
  calendar_sync: 'synced' | 'failed' | 'not_configured' | 'not_applicable';
  change_notification: 'queued' | 'not_applicable';
  reminders: BookingReminderResult[];
  reminders_created: number;
  operations: BookingOperationResult[];
}

export interface BookingSyncRetryResult {
  status: 'succeeded' | 'skipped' | 'retry_wait' | 'not_applicable';
}

export interface BookingNotificationRetryResult {
  status: 'succeeded' | 'failed';
  operation_status: string | null;
  error_code: string | null;
}

export interface BookingConflictAlternatives {
  conflict: {
    from: string;
    to: string;
    count: number;
    source: 'internal_booking' | 'google_calendar' | 'schedule';
  };
  nearbySlots: BookingAvailabilitySlot[];
  alternateStaff: Array<{
    staffId: string;
    displayName: string;
    slot: BookingAvailabilitySlot;
  }>;
}

export interface BookingCustomerSummary {
  id: string;
  line_account_id: string;
  friend_id: string | null;
  display_name: string;
  phone_last4: string;
  pet_name: string | null;
  is_line_linked: boolean;
  created_at: string;
  updated_at: string;
}
