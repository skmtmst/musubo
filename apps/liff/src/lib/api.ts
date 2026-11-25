import { legacyApiErrorBody, readApiError } from '@line-crm/shared';
import { readLiffResponse, responseLiffError } from './api-error.js';
import type { BookingCancellationPreview, MenuAddon, RoutedTarget, MakeupCredit, MakeupOption } from './api-types.js';
export type { BookingCancellationPreview, MenuAddon, RoutedTarget, MakeupCredit, MakeupOption, EventBookingMakeup } from './api-types.js';
import type { AcceptBookingWaitlistInput,BookingHistoryResponse,CustomerBookingWaitlist,CustomerSeatWaitlist,EntryRouteCouponReceived,EventWaitlistMine,EventWaitlistOfferDetail,LiffBookingChangeResponse,RegisterSeatWaitlistInput,WebinarAudience } from '@line-crm/shared';
import { buildFormSubmitHeaders,toFormIdempotencyKey } from '@line-crm/shared';
import { type AvailabilityResponse,type BookingEntitlement,type BookingPayment,type CreateBookingResponse,type CreateEventBookingResponse,type EventBookingMine,type EventDetail,type EventSlot,type FormSubmitResponse,type LastBookingResponse,type LiffBookingSettings,type MenuItem,type NotificationPreferences,type NotificationPurpose,type PostalCodeSearchResponse,type PublicForm,type StaffItem,type WaitlistMineResponse,type WebinarState } from './api-types.js';
import { getIdToken,getLiffId } from './liff-auth.js';
import type { LiffLookApiSettings } from './liff-look.js';
export type { BookingHistoryItem,EventWaitlistMine,EventWaitlistOfferDetail,WebinarAudience } from '@line-crm/shared';
export { type AvailabilityResponse,type BookingEntitlement,type BookingPayment,type CreateBookingResponse,type CreateEventBookingResponse,type EventBookingMine,type EventDetail,type EventQuestion,type EventSlot,type FormSubmitResponse,type LastBookingResponse,type LiffBookingSettings,type MenuItem,type NotificationPreferenceItem,type NotificationPreferences,type NotificationPurpose,type PostalCodeCandidate,type PostalCodeSearchResponse,type PublicForm,type StaffItem,type WaitlistMineResponse,type WebinarCta,type WebinarSakuraComment,type WebinarState } from './api-types.js';


const BASE = import.meta.env.VITE_API_BASE ?? '';

/** 支払い必須の不完全な成功応答は、通常予約・待ちからの予約とも完了にしない。 */
export function assertBookingPaymentResponse(created: CreateBookingResponse): CreateBookingResponse {
  if (created.payment_required && !created.payment?.id) throw new Error('booking_payment_unavailable');
  return created;
}

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${getIdToken()}`, ...extra };
}

/** 予約の通信で新旧の成功フラグを読む。ほかの機能の応答検査は各読み口が行う。 */
async function readResponse<T>(response: Response, path: string): Promise<T> {
  if (/^\/api\/liff\/(?:booking|restaurant|events)(?:\/|$)|^\/api\/events\/liff\//.test(path)) {
    return readLiffResponse<T>(response);
  }
  if (!response.ok) throw await responseLiffError(response);
  return response.json();
}

async function get<T>(path: string): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  url.searchParams.set('liffId', getLiffId());
  const res = await fetch(url.toString(), { headers: authHeaders() });
  return readResponse<T>(res, path);
}

/**
 * Worker が `{ success: true, data }` の包みで返す口だけ、ここで中身を取り出す。
 * GET を一律に剥がすと、包み無しで返す口（イベント・ウェビナーなど）が壊れるので、
 * 包みで返すと確かめた口だけがこれを通す。包みが無い・success が true でない応答は
 * 契約違反として投げる（黙って undefined を画面へ渡さない）。
 */
function responseShapeError(body: unknown, path: string): Error {
  const err = new Error(`API 応答の形が違います: ${path}`) as Error & { status: number; body: unknown };
  err.status = 0;
  err.body = body;
  return err;
}

export function unwrapSuccessData<T>(body: unknown, path: string): T {
  if (
    body !== null
    && typeof body === 'object'
    && (body as { success?: unknown }).success === true
    && 'data' in (body as object)
  ) {
    return (body as { data: T }).data;
  }
  throw responseShapeError(body, path);
}

async function getData<T>(path: string): Promise<T> {
  return unwrapSuccessData<T>(await get<unknown>(path), path);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** フォームだけの境界。描画に必要な配列が無い応答を画面へ渡さない。 */
async function getPublicForm(path: string): Promise<PublicForm> {
  const data = await getData<unknown>(path);
  if (!isRecord(data) || typeof data.id !== 'string' || typeof data.name !== 'string'
    || typeof data.isActive !== 'boolean' || !isRecord(data.layout)
    || !Array.isArray(data.layout.header) || !data.layout.header.every(isRecord)
    || !Array.isArray(data.layout.sections) || data.layout.sections.length === 0
    || !data.layout.sections.every((section) => isRecord(section)
      && Array.isArray(section.blocks) && section.blocks.every(isRecord))) {
    throw responseShapeError(data, path);
  }
  return data as unknown as PublicForm;
}

async function getLatestFormAnswer(path: string): Promise<{ answers: Record<string, unknown>; createdAt: string } | null> {
  const data = await getData<unknown>(path);
  if (data === null) return null;
  if (!isRecord(data) || !isRecord(data.answers) || typeof data.createdAt !== 'string') {
    throw responseShapeError(data, path);
  }
  return { answers: data.answers, createdAt: data.createdAt };
}

async function remove<T>(path:string):Promise<T>{
 const url=new URL(`${BASE}${path}`,window.location.origin);url.searchParams.set('liffId',getLiffId());
 const res=await fetch(url,{method:'DELETE',headers:authHeaders()});return readResponse<T>(res, path);
}
async function post<T>(path: string, body: unknown, headers: Record<string, string> = {}, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  url.searchParams.set('liffId', getLiffId());
  const res = await fetch(url.toString(), {
    method,
    headers: authHeaders({ 'Content-Type': 'application/json', ...headers }),
    body: JSON.stringify(body),
  });
  return readResponse<T>(res, path);
}

async function postBinary<T>(path: string, file: Blob): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin);
  url.searchParams.set('liffId', getLiffId());
  const res = await fetch(url.toString(), {
    method: 'POST',
    // ファイルの中身をそのまま送る。multipart にすると、境界の組み立てを
    // 自前で持つことになり、得るものが無い。
    headers: authHeaders({ 'Content-Type': file.type || 'application/octet-stream' }),
    body: file,
  });
  return readResponse<T>(res, path);
}

export const api = {
  customerLook: () => get<{success: boolean;data:{settings:LiffLookApiSettings;look:import('@line-crm/shared').CustomerLook;version:number}}>('/api/liff/customer-look'),
  researchForm: (id: string) => getData<{ formId: string }>(`/api/liff/research/${encodeURIComponent(id)}/form`),
  entryRouteCoupon: {
    receive: async (ref: string) => unwrapSuccessData<EntryRouteCouponReceived>(await post<unknown>('/api/liff/entry-route-coupon', { ref }), '/api/liff/entry-route-coupon'),
    use: async (receiptId: string, requestId: string) => unwrapSuccessData<{ message: string; replayed: boolean }>(await post<unknown>('/api/liff/entry-route-coupon/use', { receiptId, requestId }), '/api/liff/entry-route-coupon/use'),
  },
  /** 上の帯に出す店名など。liffId から店を決める公開口 (Worker は {success,data} で返す)。 */
  liffConfig: () =>
    get<{ success: boolean; data: { botBasicId: string; accountName: string; accountId: string; style?: unknown } }>(
      '/api/liff/config',
    ),
  menus: () => get<{ menus: MenuItem[] }>('/api/liff/booking/menus'),
  storePhotos: () => getData<Array<{ slot: 'exterior' | 'interior' | 'waiting'; url: string }>>('/api/liff/booking/store-photos'),
  staffOf: (menuId: string) =>
    get<{ staff: StaffItem[] }>(`/api/liff/booking/menus/${menuId}/staff`),
  availability: (menuId: string, staffId: string | undefined, from: string, to: string, addonIds: readonly string[] = []) => {
    const qs = new URLSearchParams({ menu_id: menuId, from, to });
    if (staffId) qs.set('staff_id', staffId);
    if (addonIds.length) qs.set('addon_ids', JSON.stringify(addonIds));
    return get<AvailabilityResponse>(`/api/liff/booking/availability?${qs}`);
  },
  /** 予約の設定を読む。読めないときは呼び側が既定（リスト・60日）に倒す。 */
  bookingSettings: () => get<LiffBookingSettings>('/api/liff/booking/settings'),
  // Worker 側で id_token を verify するので lineUserId は body に入れない。
  createRequest: (
    body: {
      menu_id: string; staff_id: string; starts_at: string; customer_note?: string; waitlist_id?: string; policyAccepted?: boolean; policyVersion?: number; setupIntentId?: string;
      /** B5：追加メニュー（1 人分・0〜3 個）。2 人以上の組は口がまだ受けない。 */
      addonIds?: string[];
      entitlement_id?: string;
      payment_method?: 'onsite' | 'online';
      /** B6：答えで決まった行き先の署名（resolve の返事）。 */
      routingToken?: string;
      meeting_mode?: 'online' | 'in_person';
    },
    idempotencyKey: string,
  ) =>
    post<CreateBookingResponse>(
      '/api/liff/booking/requests',
      body,
      { 'Idempotency-Key': idempotencyKey },
    ).then(assertBookingPaymentResponse),
  /** 予約前の見積もり。取得失敗や不完全な応答は予約確認へ伝え、同意なしで送らない。 */
  cancellationPreview: async (input: { menuId: string; staffId: string; startsAt: string }): Promise<BookingCancellationPreview> => {
    const path = `/api/liff/booking/cost-estimate?${new URLSearchParams({ menu_id: input.menuId, staff_id: input.staffId, starts_at: input.startsAt })}`;
    const data = await getData<unknown>(path);
    if (!isRecord(data) || !isRecord(data.cancellation) || !isRecord(data.deposit)) throw responseShapeError(data, path);
    const c = data.cancellation, d = data.deposit;
    if (typeof c.enabled !== 'boolean' || !Number.isInteger(c.version) || typeof c.price !== 'number'
      || typeof c.cardRequired !== 'boolean' || typeof c.noShowPercent !== 'number'
      || !(c.freeUntil === null || typeof c.freeUntil === 'string')
      || !Array.isArray(c.tiers) || c.tiers.length < 2
      || !c.tiers.every((t) => isRecord(t) && typeof t.beforeHours === 'number' && typeof t.percent === 'number')
      || typeof d.amount !== 'number') throw responseShapeError(data, path);
    const p = data.payment;
    if (p !== undefined && (!isRecord(p) || !['none', 'onsite', 'online', 'customer_choice'].includes(String(p.mode))
      || !Array.isArray(p.allowedMethods) || new Set(p.allowedMethods).size !== p.allowedMethods.length
      || !p.allowedMethods.every(method => method === 'onsite' || method === 'online')
      || (p.mode === 'none' ? p.allowedMethods.length !== 0
        : p.mode === 'customer_choice' ? !p.allowedMethods.includes('online')
          : p.allowedMethods.length !== 1 || p.allowedMethods[0] !== p.mode))) throw responseShapeError(data, path);
    return {
      enabled: c.enabled, version: c.version as number, freeUntil: c.freeUntil,
      tiers: c.tiers.map((t) => ({ beforeHours: t.beforeHours, percent: t.percent })),
      afterPercent: c.tiers[c.tiers.length - 1].percent, noShowPercent: c.noShowPercent,
      price: c.price, cardRequired: c.cardRequired,
      deposit: d.amount > 0 ? { amount: d.amount } : null,
      ...(p === undefined ? {} : { payment: p as BookingCancellationPreview['payment'] }),
    };
  },
  /** カードの登録（gap1・試験モード）。登録済みなら status=ready、まだなら url の登録画面へ。 */
  cancellationSetup: (menuId: string, idempotencyKey: string) =>
    post<{ success: true; data: { setupIntentId: string; url: string; status: string; testMode: boolean } }>('/api/liff/booking/setup-intent', { menuId, policyAccepted: true }, { 'Idempotency-Key': idempotencyKey }).then((res) => res.data),
  /** お支払いありの予約だけ payment が付く。なしの店では今までどおり付かない。 */
  startBookingPayment: (bookingId: string) =>
    post<{ payment: BookingPayment | null; checkoutUrl: string | null }>(
      '/api/liff/booking/payments/start',
      { bookingId },
    ),
  bookingPaymentStatus: (bookingId: string) =>
    get<{ payment: BookingPayment | null; operation_status?: 'unknown'; action_required?: boolean }>(
      `/api/liff/booking/payments/by-booking?bookingId=${encodeURIComponent(bookingId)}`,
    ),
  me: () => get<BookingHistoryResponse>('/api/liff/booking/me'),
  /** 組3：本人の回数券・月謝。menu_id・starts_at を渡すとその予約で使えるかが付く。 */
  entitlements: (query: { menuId?: string; startsAt?: string } = {}) => {
    const qs = new URLSearchParams();
    if (query.menuId) qs.set('menu_id', query.menuId);
    if (query.startsAt) qs.set('starts_at', query.startsAt);
    const tail = qs.toString();
    return getData<BookingEntitlement[]>(`/api/liff/booking/entitlements${tail ? `?${tail}` : ''}`);
  },
  /** 組1：お知らせの受け取り。店は /api/liff/config の accountId。 */
  notificationPreferences: (lineAccountId: string) =>
    getData<NotificationPreferences>(`/api/liff/notification-preferences?${new URLSearchParams({ lineAccountId })}`),
  updateNotificationPreference: (lineAccountId: string, purpose: NotificationPurpose, enabled: boolean, expectedVersion: number) =>
    post<{ success: true; data: NotificationPreferences }>(
      `/api/liff/notification-preferences/${encodeURIComponent(purpose)}?${new URLSearchParams({ lineAccountId })}`,
      { enabled, expectedVersion },
      {},
      'PUT',
    ).then((r) => unwrapSuccessData<NotificationPreferences>(r, '/api/liff/notification-preferences')),
  /** 本人の取消。版（lock_version）が合わないと 409。期限を過ぎると 403 self_deadline_passed。 */
  cancellationQuote: (id:string) => getData<import('@line-crm/shared').BookingCancellationReview>(`/api/liff/booking/cancellation-quote?booking_id=${encodeURIComponent(id)}`),
  cancelMyBooking: (id: string, lockVersion: number, confirmation?:import('@line-crm/shared').BookingCancellationConfirmation) =>
    post<LiffBookingChangeResponse>(`/api/liff/booking/${encodeURIComponent(id)}/cancel`, { lock_version: lockVersion, ...confirmation }),
  /** 本人の日時変更。starts_at は UTC の ISO。埋まっていると 409 slot_not_available。 */
  rescheduleMyBooking: (id: string, body: { lock_version: number; starts_at: string; reason?: string }) =>
    post<LiffBookingChangeResponse>(`/api/liff/booking/${encodeURIComponent(id)}/reschedule`, body),
  /** 前回と同じで予約：本人の前回の予約を返す。失敗・対象外は呼び側が黙って隠す。 */
  lastBooking: () => get<LastBookingResponse>('/api/liff/booking/last-booking'),
  /** 満席の枠に「空いたら知らせる」を登録する。 */
  registerWaitlist: (body: { staff_id: string; menu_id: string; starts_at: string }) =>
    post<{ id: string }>('/api/liff/booking/waitlist', body),
  bookingWaitlists:(id?:string)=>get<{waitlist:CustomerBookingWaitlist[]}>(`/api/liff/booking/waitlist${id?'?id='+encodeURIComponent(id):''}`),
  seatAvailability:(query:{storeId:string;startsAt:string;endsAt:string;guestCount:number})=>get<{success:true;data:import('@line-crm/shared').RestaurantSeatAvailability}>(`/api/liff/booking/seat-availability?${new URLSearchParams({store_id:query.storeId,starts_at:query.startsAt,ends_at:query.endsAt,guest_count:String(query.guestCount)})}`),
  seatWaitlists:(id?:string)=>get<{waitlist:CustomerSeatWaitlist[]}>(`/api/liff/booking/seat-waitlist${id?'?id='+encodeURIComponent(id):''}`),
  registerSeatWaitlist:(body:RegisterSeatWaitlistInput)=>post<{id:string}>('/api/liff/booking/seat-waitlist',body),
  acceptWaitlist:(body:AcceptBookingWaitlistInput,key:string)=>post<CreateBookingResponse>('/api/liff/booking/requests',body,{'Idempotency-Key':key}).then(assertBookingPaymentResponse),
  acceptSeatWaitlist:(id:string,key:string)=>post<{reservation_id:string;status:string}>(`/api/liff/booking/seat-waitlist/${encodeURIComponent(id)}/accept`,{}, {'Idempotency-Key':key}),
  cancelSeatWaitlist:(id:string)=>remove<{status:string}>(`/api/liff/booking/seat-waitlist/${encodeURIComponent(id)}`),
  /** 枠を指定して自分の待ち登録を返す。 */
  waitlistMine: (staffId: string, menuId: string, startsAt: string) => {
    const qs = new URLSearchParams({ staff_id: staffId, menu_id: menuId, starts_at: startsAt });
    return get<WaitlistMineResponse>(`/api/liff/booking/waitlist/mine?${qs}`);
  },
  /** 自分のキャンセル待ちを取り消す。 */
  cancelWaitlist: (id: string) =>
    fetch(`${BASE}/api/liff/booking/waitlist/${encodeURIComponent(id)}?liffId=${encodeURIComponent(getLiffId())}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(async (res) => {
      return readLiffResponse<{ status: string }>(res);
    }),

  // ===== Event booking =====
  listEvents: (cursor?:string) => get<{items:Array<{id:string;name:string;venue_name:string|null;image_url:string|null;nextStartsAt:string}>;nextCursor:string|null}>(`/api/liff/events${cursor?'?cursor='+encodeURIComponent(cursor):''}`),
  getEvent: (id: string) => get<EventDetail>(`/api/liff/events/${id}`),
  getEventSlots: (id: string) => get<{ items: EventSlot[] }>(`/api/liff/events/${id}/slots`),
  createEventBooking: (
    eventId: string,
    body: {
      slot_id: string;
      customer_note?: string | null;
      /** カスタム質問への回答。質問id → 文字列、複数選択は文字列配列 */
      answers?: Record<string, string | string[]>;
    },
    idempotencyKey: string,
  ) =>
    post<CreateEventBookingResponse>(
      `/api/liff/events/${eventId}/bookings`,
      body,
      { 'Idempotency-Key': idempotencyKey },
    ),
  myEventBookings: (tab: 'upcoming' | 'past') =>
    get<{ items: EventBookingMine[] }>(`/api/liff/events/me?tab=${tab}`),
  /** 欠席する。締めの内なら振替が 1 回付く（credit）。付かないときは reason_if_none に理由（B3・契約どおり）。 */
  eventAbsence: (bookingId: string, key: string) =>
    post<{ success: true; data: { makeupCredit: MakeupCredit | null; reasonIfNone: string | null } }>(`/api/liff/events/bookings/${encodeURIComponent(bookingId)}/absence`, {}, { 'Idempotency-Key': key })
      .then((r) => ({ credit: r.data.makeupCredit, reason_if_none: r.data.reasonIfNone ?? undefined })),
  makeupCredits: () => get<{ success: true; data: MakeupCredit[] }>('/api/liff/events/makeup-credits').then((r) => ({ credits: r.data })),
  /** 振替先の回。from はその週の最初の日（YYYY-MM-DD）。空きは定員−埋まりで数える。 */
  makeupOptions: (id: string, from: string) =>
    get<{ success: true; data: Array<{ id: string; event_id: string; starts_at: string; ends_at: string; capacity: number | null; occupied: number; name?: string | null }> }>(`/api/liff/events/makeup-credits/${encodeURIComponent(id)}/options?from=${encodeURIComponent(from)}`)
      .then((r) => ({ options: r.data.map((o): MakeupOption => ({ slot_id: o.id, event_id: o.event_id, starts_at: o.starts_at, ends_at: o.ends_at, name: o.name ?? '', remaining: o.capacity == null ? null : Math.max(0, o.capacity - o.occupied), full: o.capacity != null && o.occupied >= o.capacity })) })),
  useMakeup: (id: string, eventSlotId: string, key: string) =>
    post<{ success: true; data: { bookingId: string; replayed: boolean } }>(`/api/liff/events/makeup-credits/${encodeURIComponent(id)}/use`, { eventSlotId }, { 'Idempotency-Key': key }).then((r) => ({ id: r.data.bookingId, status: 'confirmed' })),
  myEventWaitlist: () => get<{ items: EventWaitlistMine[] }>('/api/liff/events/me/waitlist'),
  myEventWaitlistEntry: (waitlistId: string) =>
    get<EventWaitlistMine>(`/api/liff/events/me/waitlist/${encodeURIComponent(waitlistId)}`),
  cancelMyEventWaitlist: (waitlistId: string) =>
    post<{ ok: true }>(`/api/liff/events/me/waitlist/${encodeURIComponent(waitlistId)}/cancel`, {}),
  cancelMyEventBooking: (bookingId: string) =>
    post<{ ok: true }>(`/api/liff/events/me/${bookingId}/cancel`, {}),
  /**
   * 自分の申込の開催回変更。新しい席を確保できた時だけ元の申込を
   * 取り消す、まとめて1つの操作。Idempotency-Key は呼び出し側が
   * 1操作ぶん安定した鍵を使い回す。
   */
  changeMyEventBooking: (bookingId: string, toSlotId: string, idempotencyKey: string) =>
    post<{ id: string; status: string }>(
      `/api/events/liff/bookings/${bookingId}/change`,
      { to_slot_id: toSlotId },
      { 'Idempotency-Key': idempotencyKey },
    ),
  acceptEventWaitlistOffer: (token: string) =>
    post<{
      success: true;
      data: { bookingId: string; status: 'confirmed'; alreadyConfirmed: boolean };
    }>(`/api/liff/events/waitlist/${encodeURIComponent(token)}/accept`, {}),
  eventWaitlistOffer: (token: string) =>
    get<{ success: true; data: EventWaitlistOfferDetail }>(
      `/api/liff/events/waitlist/${encodeURIComponent(token)}`,
    ),

  // ===== 回答フォーム =====
  /**
   * P（試し回答）：試し合言葉を添えると、未公開の下書きをお客さまの形で返す。
   * 合言葉が違うときは 403 になる（本物としては扱わない）。
   */
  // Worker（routes/forms.ts）は `{ success: true, data: PublicForm }` で返す。
  getForm: (id: string, testToken?: string) =>
    getPublicForm(`/api/forms/${id}${testToken ? `?test_token=${encodeURIComponent(testToken)}` : ''}`),
  /**
   * 前回の自分の回答。「前回の回答を出しておく」設定のときだけ中身が返る。
   * Worker は `{ success: true, data: { answers, createdAt } | null }` で返す。
   */
  /**
   * 答えで予約の行き先を決める。
   * 行き先はこの口の返事で決まり、お客さまは書き換えられない（予約には routingToken を添える）。
   */
  resolveFormRouting: (id: string, answers: Record<string, unknown>, blockId?: string) =>
    post<{ success: true; data: { matchedIndex: number; target: { menuId: string; staffId?: string; staffGroupId?: string; meetingMode?: 'online' | 'in_person' }; routingToken: string; expiresAt: string } }>(`/api/liff/forms/${encodeURIComponent(id)}/routing/resolve`, { answers, blockId }).then((r) => r.data),
  /** 繰り返しの空きを本人の口で確かめる。画面向けに日時の名前をそろえる。 */
  seriesPreview: async (body: { menu_id: string; staff_id: string; starts_at: string; freq: 'weekly'; count: number }) => {
    const path = '/api/liff/booking/series/preview';
    const result = unwrapSuccessData<{ occurrences: Array<{ index: number; startsAt: string; available: boolean; reason: string | null; alternatives: string[] }> }>(
      await post<unknown>(path, { menuId: body.menu_id, staffId: body.staff_id, startsAt: body.starts_at, rule: { freq: body.freq, count: body.count } }), path,
    );
    return { occurrences: result.occurrences.map((o) => ({ index: o.index, starts_at: o.startsAt, available: o.available, ...(o.reason ? { reason: o.reason === 'slot_unavailable' ? '空きがありません' : '空きを確かめられません' } : {}), alternatives: o.alternatives })) };
  },
  /** 追加メニュー（B5）。メニューを選んだあと読む。 */
  addons: (menuId: string) =>
    get<{ success: true; data: Array<{ id: string; name: string; duration_minutes: number; base_price: number }> }>(`/api/liff/booking/menus/${encodeURIComponent(menuId)}/addons`)
      .then((r) => r.data.map((a): MenuAddon => ({ id: a.id, name: a.name, duration_minutes: a.duration_minutes, price: a.base_price }))),
  getMyLatestFormAnswer: (id: string) =>
    getLatestFormAnswer(`/api/forms/${id}/my-latest`),
  /**
   * フォーム回答の送信。Idempotency-Key は呼び出し側が1回答ぶん安定した
   * UUID を作って必ず渡す(連打・再送の二重回答を防ぐ。イベント予約と同じ)。
   * 未完のときは data.complete が false で返るので、同じキーで送り直す。
   *
   * HTTP の失敗では投げず、状態と本文をそのまま返す。送り直すかどうかの
   * 判定は lib/form-submit-flow.ts の判定表が行う(投げると 409 の符号が
   * 例外の形に埋もれて、自動送り直しの誤りを見逃しやすくなる)。
   */
  submitForm: async (
    id: string,
    body: { data: Record<string, unknown>; trackedLinkId?: string; testToken?: string },
    // 第3引数は必須のまま(付け忘れは従来どおり型で落ちる)。
    // 共有ヘッダ関数へ渡す際に UUID 検証を通す。呼び出し側(Form.tsx)は
    // 所有パス外のため、この境界で検証する形に留める。
    idempotencyKey: string,
    // P（試し回答）：試し合言葉を添えると、下書きへの試し回答になる。
    // 集計に入らず、後処理も動かない。
    testToken?: string,
  ): Promise<{ status: number; body: FormSubmitResponse | null }> => {
    const url = new URL(`${BASE}/api/forms/${id}/submit`, window.location.origin);
    url.searchParams.set('liffId', getLiffId());
    const res = await fetch(url.toString(), {
      method: 'POST',
      // ヘッダ組立は共有部品へ寄せる。認証の取得・URL・応答判定はここに残す。
      headers: authHeaders(buildFormSubmitHeaders(toFormIdempotencyKey(idempotencyKey))),
      body: JSON.stringify(testToken ? { ...body, testToken } : body),
    });
    let parsed: FormSubmitResponse | null = null;
    try {
      const payload: unknown = await res.json();
      parsed = (res.ok ? payload : { ...(legacyApiErrorBody(payload) as object), error: readApiError(payload).message }) as FormSubmitResponse;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  },
  /** 回答の添付を預ける。新しい質問は添付ID、従来の質問はURLを返す。 */
  uploadFormFile: (id: string, file: File, testToken?: string, blockId?: string, side = 'single') =>
    postBinary<{ success: true; data: { key?: string; url?: string; mimeType?: string; size?: number; file?: import('@line-crm/shared').FormFileAnswer; scanStatus?: string } }>(
      `/api/forms/${id}/files?${new URLSearchParams({ ...(testToken ? { test_token: testToken } : {}), ...(blockId ? { block_id: blockId, side, filename: file.name } : {}) })}`,
      file,
    ),
  /**
   * 郵便番号から住所の候補を返す（外部通信なし・日本郵便の公開データ）。
   * 候補が複数の番号は全部返す。選ばなければ手入力の住所はそのまま残す。
   */
  postalCodeSearch: (code: string) =>
    get<PostalCodeSearchResponse>(`/api/postal-code/search?code=${encodeURIComponent(code)}`),

  /**
   * 郵便番号→住所の候補。選んだ候補だけ住所へ入れ、手入力は残す。
   * 見つからない・通信失敗のときは投げず、その旨を状態で返す。
   */
  postalSearch: (code: string) =>
    get<{
      success: boolean;
      data: {
        status: 'matched' | 'multiple' | 'none' | 'invalid';
        candidates: Array<{ postalCode: string; prefecture: string; city: string; town: string }>;
        manualEntry: { note: string };
      };
    }>(`/api/postal-code/search?code=${encodeURIComponent(code)}`),

  // ===== Webinar =====
  webinarState: (slug: string) => get<WebinarState>(`/api/liff/webinars/${slug}`),
  webinarAudience: (slug: string) =>
    get<WebinarAudience>(`/api/liff/webinars/${encodeURIComponent(slug)}/audience`),
  webinarHeartbeat: (
    slug: string,
    sessionStartAt: number,
    positionSeconds: number,
    extra?: { playerState?: string; playbackRate?: number; clientAtMs?: number },
  ) =>
    post<{ ok: true }>(`/api/liff/webinars/${slug}/heartbeat`, {
      sessionStartAt, positionSeconds, ...extra,
    }),
  webinarComment: (slug: string, sessionStartAt: number, atSeconds: number, body: string) =>
    post<{ ok: true }>(`/api/liff/webinars/${slug}/comments`, { sessionStartAt, atSeconds, body }),
  webinarCtaClick: (slug: string, sessionStartAt: number) =>
    post<{ ok: true }>(`/api/liff/webinars/${slug}/cta-click`, { sessionStartAt }),
};

/** 来店スタンプ。PINを使う口には本人のIDトークンを常に送る。 */
export const visitStampsApi = {
  redeemQr:(accountId:string,token:string,requestId:string,visitId?:string)=>post<{success:true;data:import('@line-crm/shared').VisitStampQrResult}>(`/api/liff/visit-stamps/qr/redeem?${new URLSearchParams({accountId})}`,{token,requestId,visitId}),
  cards: (accountId:string) => get<{success:true;data:Array<{card:import('@line-crm/shared').VisitStampCard;wallet:import('@line-crm/shared').VisitStampWallet}>}>(`/api/liff/visit-stamps/cards?${new URLSearchParams({accountId})}`),
  card: (accountId:string,id:string) => get<{success:true;data:{card:import('@line-crm/shared').VisitStampCard;wallet:import('@line-crm/shared').VisitStampWallet;entries:import('@line-crm/shared').VisitStampEntry[]}}>(`/api/liff/visit-stamps/cards/${encodeURIComponent(id)}?${new URLSearchParams({accountId})}`),
  showReward: (accountId:string,id:string,rewardId:string,requestId:string) => post<{success:true;data:import('@line-crm/shared').VisitStampRedemption}>(`/api/liff/visit-stamps/cards/${encodeURIComponent(id)}/rewards?${new URLSearchParams({accountId})}`,{rewardId,requestId}),
  useReward: (accountId:string,id:string,pin:string) => post<{success:true;data:import('@line-crm/shared').VisitStampUseResult}>(`/api/liff/visit-stamps/redemptions/${encodeURIComponent(id)}/use?${new URLSearchParams({accountId})}`,{pin}),
  paperRequests:(accountId:string,id:string)=>get<{success:true;data:import('@line-crm/shared').VisitStampPaperRequest[]}>(`/api/liff/visit-stamps/cards/${encodeURIComponent(id)}/paper-requests?${new URLSearchParams({accountId})}`),
  uploadPaperPhoto:async(accountId:string,id:string,file:File)=>{
    const body=new FormData();body.append('file',file);
    const response=await fetch(`${BASE}/api/liff/visit-stamps/cards/${encodeURIComponent(id)}/paper-photos?${new URLSearchParams({accountId})}`,{method:'POST',headers:{Authorization:`Bearer ${getIdToken()}`},body});
    if(!response.ok)throw await responseLiffError(response);return response.json() as Promise<{success:true;data:import('@line-crm/shared').VisitStampPhoto}>;
  },
  paperPhoto:async(accountId:string,id:string)=>{
    const response=await fetch(`${BASE}/api/liff/visit-stamps/paper-photos/${encodeURIComponent(id)}?${new URLSearchParams({accountId})}`,{headers:{Authorization:`Bearer ${getIdToken()}`}});
    if(!response.ok)throw await responseLiffError(response);return response.blob();
  },
  requestPaper: (accountId:string,id:string,body:import('@line-crm/shared').VisitStampPaperInput) => post<{success:true;data:{id:string;status:'pending'}}>(`/api/liff/visit-stamps/cards/${encodeURIComponent(id)}/paper-requests?${new URLSearchParams({accountId})}`,body),
};

/** 飲食店の席予約。既存get/postと同じくliffIdと本人のIDトークンを送る。 */
export type RestaurantMenuPhoto = { id: string; url: string; x: number; y: number };
export type RestaurantMenuItem = {
  id: string;
  kind: 'course' | 'a_la_carte';
  name: string;
  price: number;
  description: string | null;
  durationMinutes: number | null;
  servicePeriods: string[];
  photos: RestaurantMenuPhoto[];
};
export type RestaurantMenuData = {
  storeId: string;
  storeName: string;
  bookingUrl: string | null;
  items: RestaurantMenuItem[];
};
export type RestaurantMenuScope = { storeId: string } | { token: string };

export const restaurantBookingApi = {
  menu: (scope: RestaurantMenuScope) =>
    getData<RestaurantMenuData>(`/api/liff/restaurant/menu?${new URLSearchParams(scope)}`),
  courses: (storeId:string)=>get<{success:true;timezone?:string;data:import('@line-crm/shared').RestaurantCustomerCourse[]}>(`/api/liff/restaurant/courses?${new URLSearchParams({storeId})}`),
  referrals: (storeId:string,date:string,guestCount:number,startsAt?:string,courseId?:string|null)=>get<{success:true;data:import('@line-crm/shared').RestaurantReferralCandidate[]}>(`/api/liff/restaurant/referrals?${new URLSearchParams({storeId,date,guestCount:String(guestCount),...(startsAt ? {startsAt}: {}),...(courseId ? {courseId}: {})})}`),
  referral: (body:{storeId:string;targetStoreId:string;date:string;startsAt:string;guestCount:number;courseId?:string|null})=>post<{success:true;data:{bookingUrl:string}}>('/api/liff/restaurant/referrals',body),
  formBooking: (body:{formId:string;blockId:string;submissionKey:string})=>post<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking}>('/api/liff/restaurant/form-booking',body),
  link: (token:string)=>get<{success:true;data:{id:string;name:string;timezone:string;reservationForm?:import('@line-crm/shared').RestaurantReservationFormSettings}}>(`/api/liff/restaurant/link/${encodeURIComponent(token)}`),
  availability: (storeId:string,date:string,guestCount:number,courseId?:string|null)=>get<{success:true;data:import('@line-crm/shared').RestaurantCustomerAvailability}>(`/api/liff/restaurant/availability?${new URLSearchParams({storeId,date,guestCount:String(guestCount),...(courseId ? {courseId}: {})})}`),
  hold: (body:import('@line-crm/shared').RestaurantCustomerHoldInput)=>post<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking}>('/api/liff/restaurant/holds',body),
  mine: (storeId:string)=>get<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking[]}>(`/api/liff/restaurant/reservations?${new URLSearchParams({storeId})}`),
  confirm: (id:string,expectedVersion:number,details:import('@line-crm/shared').RestaurantCustomerDetails & {referralId?:string}={})=>post<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking}>(`/api/liff/restaurant/reservations/${encodeURIComponent(id)}/confirm`,{...details,expectedVersion}),
  cancel: (id:string,expectedVersion:number)=>post<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking}>(`/api/liff/restaurant/reservations/${encodeURIComponent(id)}/cancel`,{expectedVersion}),
  reschedule: (id:string,body:{expectedVersion:number;startsAt:string;guestCount:number;courseId?:string|null})=>post<{success:true;data:import('@line-crm/shared').RestaurantCustomerBooking}>(`/api/liff/restaurant/reservations/${encodeURIComponent(id)}/reschedule`,body),
};
