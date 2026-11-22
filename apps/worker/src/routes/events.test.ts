import { describe, expect, test, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';

// 空き枠の SQL は専用試験で守り、ここでは /slots の接続を試すため空き判定を差し替える。
const availabilityMocks = {
  getSlotsWithRemaining: vi.fn(),
  getActiveBookingCountsBySlot: vi.fn(),
  getFriendActiveBookingCount: vi.fn(),
};
vi.mock('../services/event-availability.js', () => availabilityMocks);

const liffAuthMocks = {
  verifyCallerLineUserId: vi.fn(),
};
vi.mock('../services/liff-auth.js', () => liffAuthMocks);

const idempotencyMocks = {
  reserveEventIdempotency: vi.fn(),
  finalizeEventIdempotencyResponse: vi.fn(),
  purgeExpiredEventIdempotency: vi.fn(),
};
vi.mock('../services/event-booking-idempotency.js', () => idempotencyMocks);

const reminderMocks = {
  computeRemindersForBooking: vi.fn(() => []),
  insertRemindersForBooking: vi.fn(),
  cancelPendingRemindersFor: vi.fn(),
};
vi.mock('../services/event-booking-reminders.js', () => reminderMocks);

const notifierMocks = {
  sendEventBookingNotification: vi.fn(),
  renderEventNotificationText: vi.fn(),
};
vi.mock('../services/event-booking-notifier.js', () => notifierMocks);

const waitlistMocks = {
  getMyEventWaitlist: vi.fn(async () => []),
  createEventWaitlistOfferSender: vi.fn(() => vi.fn()),
  enqueueEventWaitlistPromotion: vi.fn(async () => true),
  getEventOccurrenceApplicants: vi.fn(),
  getEventOccurrenceUsedSeats: vi.fn(),
  promoteEventWaitlist: vi.fn(),
  processEventWaitlistPromotionJobs: vi.fn(),
};
vi.mock('../services/event-waitlist.js', () => waitlistMocks);

const applicantSnapshotMocks = {
  createEventApplicantSnapshot: vi.fn(),
  getEventApplicantSnapshot: vi.fn(),
};
vi.mock('../services/event-applicant-snapshot.js', () => applicantSnapshotMocks);

const { default: events, summarizeFutureEventSlots } = await import('./events.js');

type TestEnv = {
  Variables: { staff: { id: string; role: 'owner' | 'admin' | 'staff' } };
  Bindings: { DB: D1Database };
};

interface EventRow {
  id: string;
  line_account_id: string;
  name: string;
  venue_name: string | null;
  venue_url: string | null;
  image_url: string | null;
  description: string | null;
  description_centered: number;
  max_bookings_per_friend: number | null;
  requires_approval: number;
  approval_deadline_hours: number;
  cancel_deadline_hours_before: number | null;
  reminder_day_before_enabled: number;
  reminder_hours_before: number | null;
  is_published: number;
  folder_id: string | null;
  sort_order: number;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  current_published_version_id: string | null;
  version_write_token?: string | null;
  target_type?: 'single' | 'multi-account-dedup';
  account_ids?: string | null;
  dedup_priority?: string | null;
  [k: string]: unknown;
}

interface SlotRow {
  id: string;
  event_id: string;
  starts_at: string;
  ends_at: string;
  capacity: number | null;
  is_active: number;
  sort_order: number;
  deleted_at: string | null;
  [k: string]: unknown;
}

interface BookingRow {
  id: string;
  event_id: string;
  status: string;
  slot_id?: string;
  friend_id?: string;
  [k: string]: unknown;
}

interface LineAccount {
  id: string;
  liff_id: string;
  is_active: number;
  tenant_id?: string | null;
  channel_access_token?: string;
}

interface FriendRow {
  id: string;
  line_account_id: string;
  line_user_id: string;
  user_id?: string | null;
  picture_url?: string | null;
}

function makeEventDb(state: {
  events: EventRow[];
  slots?: SlotRow[];
  bookings?: BookingRow[];
  accounts?: LineAccount[];
  friends?: FriendRow[];
  /** [friendId, tagId] の組。公開対象の絞り込みで引かれる */
  friendTags?: Array<{ friend_id: string; tag_id: string }>;
  /** タグの名前。一覧の「申込条件」が visible_tag_id から名前を引く */
  tags?: Array<{ id: string; name: string }>;
  /** キャンセル待ちの行。INSERT がここへ積まれる */
  waitlist?: Array<Record<string, unknown>>;
  /** 予約ごとの通知予定 (event_booking_reminders)。 の一覧添付用。 */
  reminders?: Array<Record<string, unknown>>;
}): D1Database {
  state.slots ??= [];
  // 本番の event_slots.version は DEFAULT 1（migration 324）。版を持たない
  //  fixture は初版として扱い、m26g の期待版の事前確認が本番と同じになる。
  for (const s of state.slots) s.version ??= 1;
  state.bookings ??= [];
  state.accounts ??= [];
  state.friends ??= [];
  state.friendTags ??= [];
  state.tags ??= [];
  state.waitlist ??= [];
  state.reminders ??= [];
  const eventMatchesAccount = (event: EventRow, account: string): boolean => {
    if (event.target_type === 'multi-account-dedup') {
      try {
        return (JSON.parse(event.account_ids ?? '[]') as string[]).includes(account);
      } catch {
        return false;
      }
    }
    return event.line_account_id === account;
  };
  const filterAdminEvents = (sql: string, bound: unknown[]): EventRow[] => {
    const account = bound[0] as string;
    // 名前検索は LIKE ではなく instr(lower(e.name), lower(?)) > 0。
    // 束縛は `%q%` ではなく検索語そのものが来る。
    const query = sql.includes('instr(lower(e.name)') ? String(bound[2] ?? '') : '';
    return state.events.filter((event) => {
      if (event.deleted_at != null || !eventMatchesAccount(event, account)) return false;
      if (query && !event.name.includes(query)) return false;
      if (sql.includes('e.is_published = 1') && event.is_published !== 1) return false;
      // 公開済みを要求する問い（受付中のみ・全体集計）は、今後の有効な
      // 枠がある行だけ（本番の EXISTS と同じ決め方）。次回日時の副問い合わせ
      // にも同じ文字列があるため、公開条件と組み合わせて判定する。
      if (sql.includes('e.is_published = 1') && sql.includes('s.starts_at >= strftime')) {
        const hasFuture = (state.slots ?? []).some(
          (slot) => slot.event_id === event.id && slot.deleted_at == null && slot.is_active === 1
            && slot.starts_at > new Date().toISOString(),
        );
        if (!hasFuture) return false;
      }
      if (sql.includes('pending.event_id = e.id') && !(state.bookings ?? []).some((booking) => booking.event_id === event.id && booking.status === 'requested')) return false;
      if (sql.includes('NOT EXISTS (SELECT 1 FROM event_slots cap')) {
        const slots = (state.slots ?? []).filter((slot) => slot.event_id === event.id && slot.deleted_at == null && slot.is_active === 1);
        if (slots.length === 0 || slots.some((slot) => slot.capacity == null)) return false;
        const capacity = slots.reduce((sum, slot) => sum + (slot.capacity ?? 0), 0);
        const active = (state.bookings ?? []).filter((booking) => booking.event_id === event.id && ['requested', 'confirmed'].includes(booking.status)).length;
        if (active < capacity) return false;
      }
      return true;
    });
  };
  const db = {
    prepare(sql: string) {
      let bound: unknown[] = [];
      const stmt = {
        bind(...args: unknown[]) {
          bound = args;
          return stmt;
        },
        async first<T>() {
          // SELECT id FROM line_accounts WHERE liff_id = ? AND is_active = 1
          if (sql.startsWith('SELECT id FROM line_accounts')) {
            const [liff_id] = bound as [string];
            const acc = (state.accounts ?? []).find(
              (a) => a.liff_id === liff_id && a.is_active === 1,
            );
            return (acc ? { id: acc.id } : null) as T | null;
          }
          // SELECT channel_access_token FROM line_accounts WHERE id = ?
          if (sql.startsWith('SELECT channel_access_token FROM line_accounts')) {
            const [id] = bound as [string];
            const acc = (state.accounts ?? []).find((a) => a.id === id);
            return (acc ? { channel_access_token: acc.channel_access_token ?? '' } : null) as T | null;
          }
          // 即時通知で使うアカウントと追加文面の取得を扱う。
          if (
            sql.startsWith('SELECT la.channel_access_token,') &&
            sql.includes('la.channel_access_token_encrypted') &&
            sql.includes('e.confirmation_message_extra')
          ) {
            const [event_id, account_id] = bound as [string, string];
            const acc = (state.accounts ?? []).find((a) => a.id === account_id);
            const ev = state.events.find((x) => x.id === event_id);
            if (!acc || !ev) return null as T | null;
            return {
              channel_access_token: acc.channel_access_token ?? '',
              channel_access_token_encrypted: null,
              confirmation_message_extra: (ev as Record<string, unknown>).confirmation_message_extra ?? null,
            } as T;
          }
          // 詳細の JOIN も FROM friends を含むため、タグの判定を先に置き、友だち検索と誤認しないようにする。
          if (sql.includes('friend_tags')) {
            if (sql.includes('JOIN friends')) {
              const [lineUserId, account, tagId] = bound as [string, string, string];
              const f = (state.friends ?? []).find(
                (x) => x.line_user_id === lineUserId && x.line_account_id === account,
              );
              const hit =
                f && (state.friendTags ?? []).some((t) => t.friend_id === f.id && t.tag_id === tagId);
              return (hit ? { 1: 1 } : null) as T | null;
            }
            const [friendId, tagId] = bound as [string, string];
            const hit = (state.friendTags ?? []).some(
              (t) => t.friend_id === friendId && t.tag_id === tagId,
            );
            return (hit ? { 1: 1 } : null) as T | null;
          }
          // SELECT id [, user_id] FROM friends WHERE line_user_id = ? AND line_account_id = ?
          if (sql.includes('FROM friends')) {
            const [lineUserId, account] = bound as [string, string];
            const f = (state.friends ?? []).find(
              (x) => x.line_user_id === lineUserId && x.line_account_id === account,
            );
            if (!f) return null as T | null;
            // POST 予約用は is_following = 1 の filter があるが、テスト friend は
            // 既存テストで is_following を持たないため pass。SELECT が user_id を
            // 含めば返す。
            if (sql.includes('user_id') || sql.includes('picture_url')) {
              return {
                id: f.id,
                user_id: f.user_id ?? null,
                picture_url: f.picture_url ?? null,
              } as T;
            }
            return { id: f.id } as T;
          }

          if (sql.includes('SELECT id, name, image_url, description, venue_name')) {
            const [id, account] = bound as [string, string];
            const e = state.events.find(
              (x) => x.id === id && x.line_account_id === account && x.deleted_at == null && x.is_published === 1,
            );
            return (e ? {
              ...e,
              approval_deadline_hours: e.approval_deadline_hours ?? 24,
              current_published_version_id: e.current_published_version_id ?? null,
            } : null) as T | null;
          }
          if(sql.startsWith('SELECT capacity,classroom_capacity,online_capacity FROM event_slots')){
            const slot=(state.slots??[]).find(row=>row.id===bound[0]);
            return (slot?{capacity:slot.capacity,classroom_capacity:null,online_capacity:null}:null) as T|null;
          }
          if(sql.startsWith('SELECT COALESCE((SELECT SUM(party_size) FROM event_bookings')){
            const count=(state.bookings??[]).filter(row=>(row as Record<string,unknown>).slot_id===bound[0]&&['requested','confirmed'].includes(row.status)).reduce((n,row)=>n+Number((row as Record<string,unknown>).party_size??1),0)+(state.waitlist??[]).filter(row=>row.slot_id===bound[3]&&['offered','accepted'].includes(String(row.status))).reduce((n,row)=>n+Number(row.party_size??1),0);
            return {count} as T;
          }
          // SELECT capacity FROM event_slots WHERE id = ?
          if (sql.startsWith('SELECT capacity FROM event_slots')) {
            const [id] = bound as [string];
            const s = (state.slots ?? []).find((x) => x.id === id);
            return (s ? { capacity: s.capacity } : null) as T | null;
          }
          // SELECT id, event_id, starts_at, is_active, deleted_at FROM event_slots WHERE id = ? AND event_id = ?
          if (sql.startsWith('SELECT id, event_id, starts_at, ends_at, is_active, deleted_at')) {
            const [id, event_id] = bound as [string, string];
            const s = (state.slots ?? []).find(
              (x) => x.id === id && x.event_id === event_id && x.deleted_at == null,
            );
            return (s ?? null) as T | null;
          }
          // 通知文面が使うイベント名・会場・アカウントの JOIN を扱う。
          if (sql.includes('FROM event_bookings b') && sql.includes('channel_access_token')) {
            const [bookingId] = bound as [string];
            const b = (state.bookings ?? []).find((x) => x.id === bookingId);
            if (!b) return null as T | null;
            const e = state.events.find((x) => x.id === b.event_id);
            const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
            const la = (state.accounts ?? []).find((x) => x.id === (b as Record<string, unknown>).line_account_id);
            const f = (state.friends ?? []).find((x) => x.id === (b as Record<string, unknown>).friend_id);
            if (!e || !s || !la || !f) return null as T | null;
            return {
              event_name: e.name,
              venue_name: e.venue_name,
              venue_url: e.venue_url,
              confirmation_message_extra: (e as Record<string, unknown>).confirmation_message_extra ?? null,
              slot_starts_at: s.starts_at,
              channel_access_token: la.channel_access_token ?? '',
              channel_access_token_encrypted: null,
              line_user_id: f.line_user_id,
            } as T;
          }
          // 操作対象の予約を ID とイベント ID で解決する。複数アカウントの予約を、代表アカウント1つだけで絞らない。
          if (sql.includes('FROM event_bookings\n        WHERE id = ? AND event_id = ?')) {
            const [id, event_id] = bound as [string, string];
            const b = (state.bookings ?? []).find(
              (x) =>
                x.id === id &&
                (x as Record<string, unknown>).event_id === event_id,
            );
            if (!b) return null as T | null;
            return {
              id: b.id,
              line_account_id: (b as Record<string, unknown>).line_account_id as string,
              event_id: b.event_id,
              slot_id: (b as Record<string, unknown>).slot_id as string,
              friend_id: (b as Record<string, unknown>).friend_id as string,
              status: b.status,
              decided_at: ((b as Record<string, unknown>).decided_at as string | null) ?? null,
            } as T;
          }
          // SELECT * FROM event_bookings WHERE id = ?
          if (sql.startsWith('SELECT * FROM event_bookings')) {
            const [id] = bound as [string];
            const b = (state.bookings ?? []).find((x) => x.id === id);
            return (b ?? null) as T | null;
          }
          // SELECT starts_at FROM event_slots WHERE id = ?
          if (sql.startsWith('SELECT starts_at FROM event_slots')) {
            const [id] = bound as [string];
            const s = (state.slots ?? []).find((x) => x.id === id);
            return (s ? { starts_at: s.starts_at } : null) as T | null;
          }
          // SELECT reminder_day_before_enabled, reminder_hours_before FROM events WHERE id = ?
          if (sql.startsWith('SELECT reminder_day_before_enabled')) {
            const [id] = bound as [string];
            const e = state.events.find((x) => x.id === id);
            return (e ? {
              reminder_day_before_enabled: e.reminder_day_before_enabled,
              reminder_hours_before: e.reminder_hours_before,
            } : null) as T | null;
          }
          // 通知待ちの件数はアカウントと requested 状態で数える。
          if (sql.includes('COUNT(*) AS c') && sql.includes('FROM event_bookings') && sql.includes("status = 'requested'")) {
            const [account_id] = bound as [string];
            const c = (state.bookings ?? []).filter(
              (b) =>
                (b as Record<string, unknown>).line_account_id === account_id &&
                b.status === 'requested',
            ).length;
            return { c } as T;
          }
          // POST の sameIdentityActive 検出 (window 関数 COUNT(*) OVER  で total を返す)
          if (sql.includes('FROM event_bookings b') && sql.includes('identity_key') && sql.includes('COUNT(*) OVER')) {
            const [event_id, idKey] = bound as [string, string];
            const matches = (state.bookings ?? [])
              .filter(
                (x) =>
                  x.event_id === event_id &&
                  (x as Record<string, unknown>).identity_key === idKey &&
                  (x.status === 'requested' || x.status === 'confirmed'),
              );
            if (matches.length === 0) return null as T | null;
            const b = matches[0];
            const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
            return {
              id: b.id,
              status: b.status,
              slot_starts_at: s?.starts_at ?? null,
              total: matches.length,
            } as T;
          }
          // INSERT 後にも、イベントと本人識別で上限を数え直す。
          if (sql.includes('FROM event_bookings') && sql.includes('COUNT(*) AS c') && sql.includes('identity_key')) {
            const [event_id, idKey] = bound as [string, string];
            const c = (state.bookings ?? []).filter(
              (x) =>
                x.event_id === event_id &&
                (x as Record<string, unknown>).identity_key === idKey &&
                (x.status === 'requested' || x.status === 'confirmed'),
            ).length;
            return { c } as T;
          }
          // 自己取消と予約済み判定は、予約と枠を JOIN して状態・開始時刻・所属を取得する。
          if (sql.includes('FROM event_bookings b') && sql.includes('identity_key')) {
            const [event_id, idKey] = bound as [string, string];
            const b = (state.bookings ?? []).find(
              (x) =>
                x.event_id === event_id &&
                (x as Record<string, unknown>).identity_key === idKey &&
                (x.status === 'requested' || x.status === 'confirmed'),
            );
            if (!b) return null as T | null;
            const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
            return {
              id: b.id,
              status: b.status,
              line_account_id: (b as Record<string, unknown>).line_account_id,
              slot_starts_at: s?.starts_at ?? null,
            } as T;
          }
          // 詳細は予約・イベント・枠を JOIN し、予約 ID・本人・アカウントで絞る。
          if (sql.includes('FROM event_bookings b') && sql.includes('event_description') && sql.includes('cancel_deadline_hours_before')) {
            const [bookingId, friend_id, account_id] = bound as [string, string, string];
            const b = (state.bookings ?? []).find(
              (x) => x.id === bookingId && (x as Record<string, unknown>).friend_id === friend_id && (x as Record<string, unknown>).line_account_id === account_id,
            );
            if (!b) return null as T | null;
            const e = state.events.find((x) => x.id === b.event_id);
            const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
            if (!e || !s) return null as T | null;
            return {
              id: b.id,
              event_id: b.event_id,
              status: b.status,
              customer_note: (b as Record<string, unknown>).customer_note ?? null,
              requested_at: null,
              decided_at: null,
              cancelled_at: null,
              event_name: e.name,
              event_image_url: e.image_url,
              venue_name: e.venue_name,
              venue_url: e.venue_url,
              cancel_deadline_hours_before: e.cancel_deadline_hours_before,
              event_description: (e as Record<string, unknown>).description ?? null,
              confirmation_message_extra: b.status === 'confirmed' ? ((e as Record<string, unknown>).confirmation_message_extra ?? null) : null,
              slot_starts_at: s.starts_at,
              slot_ends_at: s.ends_at,
            } as T;
          }
          // 自己取消の締切を、予約状態とイベント設定・枠時刻から解決する。
          if (sql.includes('FROM event_bookings b') && sql.includes('cancel_deadline_hours_before')) {
            const [bookingId, friend_id, account_id] = bound as [string, string, string];
            const b = (state.bookings ?? []).find(
              (x) => x.id === bookingId && (x as Record<string, unknown>).friend_id === friend_id && (x as Record<string, unknown>).line_account_id === account_id,
            );
            if (!b) return null as T | null;
            const e = state.events.find((x) => x.id === b.event_id);
            const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
            if (!e || !s) return null as T | null;
            return {
              id: b.id,
              status: b.status,
              line_account_id: (b as Record<string, unknown>).line_account_id,
              event_id: b.event_id,
              slot_id: (b as Record<string, unknown>).slot_id,
              cancel_deadline_hours_before: e.cancel_deadline_hours_before,
              slot_starts_at: s.starts_at,
            } as T;
          }
          // SELECT id FROM event_slots WHERE id = ? AND event_id = ? AND deleted_at IS NULL
          if (sql.startsWith('SELECT id FROM event_slots')) {
            const [id, event_id] = bound as [string, string];
            const s = (state.slots ?? []).find(
              (x) => x.id === id && x.event_id === event_id && x.deleted_at == null,
            );
            return (s ? { id: s.id } : null) as T | null;
          }
          // SELECT * FROM event_slots WHERE id = ? AND event_id = ? AND deleted_at IS NULL
          if (sql.startsWith('SELECT * FROM event_slots') && sql.includes('event_id')) {
            const [id, event_id] = bound as [string, string];
            const s = (state.slots ?? []).find(
              (x) => x.id === id && x.event_id === event_id && x.deleted_at == null,
            );
            return (s ?? null) as T | null;
          }
          // SELECT * FROM event_slots WHERE id = ?
          if (sql.startsWith('SELECT * FROM event_slots')) {
            const [id] = bound as [string];
            const s = (state.slots ?? []).find((x) => x.id === id);
            return (s ?? null) as T | null;
          }
          if (
            sql.includes('SELECT COUNT(*) AS c FROM event_bookings')
            && sql.includes("status = 'attended'")
          ) {
            const [friend_id, checked_at] = bound as [string, string];
            const c = (state.bookings ?? []).filter((booking) => {
              const row = booking as Record<string, unknown>;
              return row.friend_id === friend_id
                && booking.status === 'attended'
                && String(row.requested_at ?? '') < checked_at;
            }).length;
            return { c } as T;
          }
          if (sql.includes('AS requested_count') && sql.includes('FROM event_bookings WHERE event_id = ?')) {
            const [event_id] = bound as [string];
            const rows = (state.bookings ?? []).filter((booking) => booking.event_id === event_id);
            const count = (status: string) => rows.filter((booking) => booking.status === status).length;
            const seats = (status: string) => rows
              .filter((booking) => booking.status === status)
              .reduce((sum, booking) => sum + Number((booking as Record<string, unknown>).party_size ?? 1), 0);
            return {
              total: rows.length,
              requested_count: count('requested'),
              confirmed_count: count('confirmed'),
              rejected_count: count('rejected'),
              cancelled_count: count('cancelled'),
              expired_count: count('expired'),
              attended_count: count('attended'),
              no_show_count: count('no_show'),
              requested_seats: seats('requested'),
              confirmed_seats: seats('confirmed'),
            } as T;
          }
          // bookings/summary の待ち列集計。同じテーブルへの別SELECT
          // (SELECT id FROM event_waitlist ...) と混ざらないよう waiting_seats で絞る。
          if (sql.includes('waiting_seats') && sql.includes('FROM event_waitlist WHERE event_id = ?')) {
            const [event_id] = bound as [string];
            const active = new Set(['waiting', 'offered', 'accepted']);
            const rows = (state.waitlist ?? []).filter(
              (row) => row.event_id === event_id && active.has(String(row.status)),
            );
            const seats = (statuses: string[]) => rows
              .filter((row) => statuses.includes(String(row.status)))
              .reduce((sum, row) => sum + Number((row as Record<string, unknown>).party_size ?? 1), 0);
            return {
              c: rows.length,
              waiting_seats: seats(['waiting']),
              offered_seats: seats(['offered', 'accepted']),
            } as T;
          }
          if (sql.includes('AS slot_count') && sql.includes('FROM event_slots WHERE event_id = ?')) {
            const [event_id] = bound as [string];
            const slots = (state.slots ?? []).filter(
              (slot) => slot.event_id === event_id && slot.deleted_at == null && slot.is_active === 1,
            );
            return {
              slot_count: slots.length,
              uncapped_count: slots.filter((slot) => slot.capacity == null).length,
              total_capacity: slots.reduce((sum, slot) => sum + (slot.capacity ?? 0), 0),
            } as T;
          }
          // 申込一覧の総数(点検の中8)。使用席数の枝より前に置く。
          // 絞りがあるときは bound が [event_id, status?, slot_id?] の順に積まれる。
          if (sql.startsWith('SELECT COUNT(*) AS c FROM event_bookings b')) {
            const [event_id, second, third] = bound as [string, string?, string?];
            const filterStatus = sql.includes('b.status = ?') ? second : null;
            const filterSlot = sql.includes('b.slot_id = ?') ? (filterStatus ? third : second) : null;
            const c = (state.bookings ?? []).filter(
              (b) => b.event_id === event_id
                && (filterStatus ? b.status === filterStatus : true)
                && (filterSlot ? (b as Record<string, unknown>).slot_id === filterSlot : true),
            ).length;
            return { c } as T;
          }
          // 開催回の使用席数。複数人申込は party_size の合計で数える。
          if (
            sql.includes('FROM event_bookings')
            && (sql.includes('COUNT(*) AS c') || sql.includes('SUM(party_size)'))
            && sql.includes('slot_id = ?')
          ) {
            const [slot_id] = bound as [string];
            const c = (state.bookings ?? [])
              .filter(
                (b) => (b as BookingRow & { slot_id?: string }).slot_id === slot_id && (b.status === 'requested' || b.status === 'confirmed'),
              )
              .reduce((sum, booking) => sum + Number((booking as Record<string, unknown>).party_size ?? 1), 0);
            return { c } as T;
          }
          // 単一アカウントは line_account_id、複数アカウントは account_ids に含まれるかでイベントの所属を判定する。
          if (sql.includes('SELECT id FROM events') && sql.includes('is_published')) {
            const [id, account, account2] = bound as [string, string, string?];
            const acct = account2 ?? account;
            const e = state.events.find(
              (x) => x.id === id && x.deleted_at == null && x.is_published === 1 && eventMatchesAccount(x, acct),
            );
            return (e ? { id: e.id } : null) as T | null;
          }

          if (sql.includes('SELECT id FROM events')) {
            const [id, account, account2] = bound as [string, string, string?];
            const acct = account2 ?? account;
            const e = state.events.find(
              (x) => x.id === id && x.deleted_at == null && eventMatchesAccount(x, acct),
            );
            return (e ? { id: e.id } : null) as T | null;
          }

          if (sql.includes('SELECT * FROM events') && sql.includes('is_published')) {
            const [id, account, account2] = bound as [string, string, string?];
            const acct = account2 ?? account;
            const e = state.events.find(
              (x) => x.id === id && x.deleted_at == null && x.is_published === 1 && eventMatchesAccount(x, acct),
            );
            return (e ?? null) as T | null;
          }
          // admin SELECT * FROM events ... 単独 / multi 両対応
          if (sql.includes('SELECT * FROM events') && (sql.includes('line_account_id') || sql.includes('target_type'))) {
            const [id, account, account2] = bound as [string, string, string?];
            const acct = account2 ?? account;
            const e = state.events.find(
              (x) => x.id === id && x.deleted_at == null && eventMatchesAccount(x, acct),
            );
            return (e ?? null) as T | null;
          }
          // SELECT * FROM events WHERE id = ?
          if (sql.includes('SELECT * FROM events')) {
            const [id] = bound as [string];
            const e = state.events.find((x) => x.id === id);
            return (e ?? null) as T | null;
          }
          // イベント一覧の総数(点検の中8)。
          if (sql.startsWith('SELECT COUNT(*) AS c FROM events e')) {
            const c = filterAdminEvents(sql, bound).length;
            return { c } as T;
          }
          return null;
        },
        async all<T>() {
          if (
            sql.includes('SELECT id, tenant_id, parent_line_account_id') &&
            sql.includes('WHERE COALESCE(tenant_id, ?) = ?')
          ) {
            const [defaultTenantId, tenantId] = bound as [string, string];
            const results = (state.accounts ?? [])
              .filter((account) => (account.tenant_id ?? defaultTenantId) === tenantId)
              .map((account) => ({
                id: account.id,
                tenant_id: account.tenant_id ?? null,
                parent_line_account_id: null,
                is_active: account.is_active,
                archived_at: null,
                login_channel_id: null,
                liff_id: account.liff_id,
              }));
            return { results } as { results: T[] };
          }
          if (sql.startsWith('SELECT * FROM line_accounts')) {
            return { results: state.accounts ?? [] } as { results: T[] };
          }
          // 一覧の全体集計。今後の有効な枠だけを数える。
          // 管理一覧の問い（`FROM events e` を含む）より前に置く。
          if (sql.includes('e.id = s.event_id')) {
            const nowIso = new Date().toISOString();
            const targets = filterAdminEvents(sql, bound);
            const rows = [];
            for (const e of targets) {
              for (const s of (state.slots ?? []).filter(
                (slot) => slot.event_id === e.id && slot.deleted_at == null && slot.is_active === 1
                  && slot.starts_at > nowIso,
              )) {
                const active = (state.bookings ?? [])
                  .filter((b) => (b.slot_id === s.id) && (b.status === 'requested' || b.status === 'confirmed'))
                  .reduce((sum, b) => sum + (Number((b as Record<string, unknown>).party_size) || 1), 0)
                  + (state.waitlist ?? [])
                    .filter((w) => w.slot_id === s.id && (w.status === 'offered' || w.status === 'accepted'))
                    .reduce((sum, w) => sum + (Number(w.party_size) || 1), 0);
                rows.push({ id: s.id, event_id: s.event_id, starts_at: s.starts_at, capacity: s.capacity, active_count: active });
              }
            }
            return { results: rows as unknown as T[] };
          }
          // 副問い合わせも event_slots を参照するため、管理一覧の判定を枠の分岐より先に置く。
          if (sql.startsWith('SELECT\n         e.*') || (sql.includes('FROM events e') && (sql.includes('e.line_account_id') || sql.includes('e.target_type')))) {
            const items = filterAdminEvents(sql, bound)
              .map((e) => {
                const slots = (state.slots ?? []).filter(
                  (s) => s.event_id === e.id && s.deleted_at == null && s.is_active === 1,
                );
                const futureSlots = slots.filter(
                  (s) => s.starts_at > new Date().toISOString(),
                );
                const next_slot_starts_at =
                  futureSlots.length > 0
                    ? futureSlots
                        .map((s) => s.starts_at)
                        .sort()[0]
                    : null;
                // 本番と同じ決め方(点検の中6): 定員なしの枠が混ざれば合計なし。
                const cap = slots.some((s) => s.capacity == null)
                  ? null
                  : slots.length > 0
                    ? slots.reduce((acc, s) => acc + (s.capacity ?? 0), 0)
                    : null;
                const total_active = (state.bookings ?? []).filter(
                  (b) => b.event_id === e.id && (b.status === 'requested' || b.status === 'confirmed'),
                ).length;
                const pending_count = (state.bookings ?? []).filter(
                  (b) => b.event_id === e.id && b.status === 'requested',
                ).length;
                // 消えたタグを指したままの行は名前が引けず null になる。
                const visible_tag_name = e.visible_tag_id
                  ? ((state.tags ?? []).find((t) => t.id === e.visible_tag_id)?.name ?? null)
                  : null;
                return {
                  ...e,
                  next_slot_starts_at,
                  total_capacity: cap,
                  total_active,
                  pending_count,
                  visible_tag_name,
                };
              })
              .sort((a, b) => sql.includes('e.name COLLATE NOCASE')
                ? a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
                : (a.next_slot_starts_at == null ? 1 : b.next_slot_starts_at == null ? -1 : a.next_slot_starts_at.localeCompare(b.next_slot_starts_at)) || a.id.localeCompare(b.id));
            // 本番は LIMIT/OFFSET を付ける(点検の中8)。bound の末尾2つ。
            const limit = typeof bound[bound.length - 2] === 'number' ? (bound[bound.length - 2] as number) : items.length;
            const offset = typeof bound[bound.length - 1] === 'number' ? (bound[bound.length - 1] as number) : 0;
            return { results: items.slice(offset, offset + limit) as unknown as T[] };
          }
          // 一覧に添える通知予定。booking_id IN (...) の行だけ返す。
          if (sql.includes('FROM event_booking_reminders')) {
            const ids = new Set(sql.includes('json_each(?)')
              ? JSON.parse(bound[0] as string) as string[]
              : bound as string[]);
            const rows = (state.reminders ?? [])
              .filter((r) => ids.has(String(r.booking_id)))
              .sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)));
            return { results: rows as unknown as T[] };
          }

          if (sql.includes('FROM event_bookings b') && sql.includes('friend_display_name')) {
            const event_id = bound[0] as string;
            const filterStatus = sql.includes('b.status = ?') ? (bound[1] as string) : null;
            const filterSlot = sql.includes('b.slot_id = ?')
              ? (bound[filterStatus ? 2 : 1] as string)
              : null;
            const items = (state.bookings ?? [])
              .filter((b) => b.event_id === event_id)
              .filter((b) => (filterStatus ? b.status === filterStatus : true))
              .filter((b) => (filterSlot ? (b as Record<string, unknown>).slot_id === filterSlot : true))
              .map((b) => {
                const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
                const f = (state.friends ?? []).find((x) => x.id === (b as Record<string, unknown>).friend_id);
                return {
                  ...b,
                  slot_starts_at: s?.starts_at ?? null,
                  slot_ends_at: s?.ends_at ?? null,
                  friend_display_name: (f as { display_name?: string } | undefined)?.display_name ?? null,
                  friend_line_user_id: f?.line_user_id ?? null,
                };
              });
            // 本番は LIMIT/OFFSET を付ける(点検の中8)。bound の末尾2つ。
            const limit = typeof bound[bound.length - 2] === 'number' ? (bound[bound.length - 2] as number) : items.length;
            const offset = typeof bound[bound.length - 1] === 'number' ? (bound[bound.length - 1] as number) : 0;
            return { results: items.slice(offset, offset + limit) as unknown as T[] };
          }

          if (sql.includes('FROM event_bookings b') && sql.includes('event_name')) {
            const [friend_id, account_id, nowIso] = bound as [string, string, string];
            const isUpcoming = sql.includes("status IN ('requested','confirmed')")
              && sql.includes("json_extract(b.event_snapshot_json, '$.slotStartsAt')")
              && sql.includes('>= ?');
            const items = (state.bookings ?? [])
              .filter((b) => {
                const r = b as Record<string, unknown>;
                return r.friend_id === friend_id && r.line_account_id === account_id;
              })
              .map((b) => {
                const e = state.events.find((x) => x.id === b.event_id);
                const s = (state.slots ?? []).find((x) => x.id === (b as Record<string, unknown>).slot_id);
                if (!e || !s) return null;
                return {
                  id: b.id,
                  status: b.status,
                  customer_note: (b as Record<string, unknown>).customer_note ?? null,
                  requested_at: null,
                  decided_at: null,
                  cancelled_at: null,
                  event_name: e.name,
                  event_image_url: e.image_url,
                  venue_name: e.venue_name,
                  venue_url: e.venue_url,
                  cancel_deadline_hours_before: e.cancel_deadline_hours_before,
                  slot_starts_at: s.starts_at,
                  slot_ends_at: s.ends_at,
                };
              })
              .filter((r): r is NonNullable<typeof r> => r !== null)
              .filter((r) => {
                const isActive = r.status === 'requested' || r.status === 'confirmed';
                if (isUpcoming) return isActive && r.slot_starts_at >= nowIso;
                return !isActive || r.slot_starts_at < nowIso;
              })
              .sort((a, b) =>
                isUpcoming
                  ? a.slot_starts_at.localeCompare(b.slot_starts_at)
                  : b.slot_starts_at.localeCompare(a.slot_starts_at),
              );
            return { results: items as unknown as T[] };
          }

          if (sql.includes('SELECT id, event_id, starts_at, ends_at, capacity, is_active, sort_order')
            && sql.includes('FROM event_slots WHERE event_id = ?')) {
            const [event_id] = bound as [string];
            const items = (state.slots ?? [])
              .filter((slot) => slot.event_id === event_id && slot.deleted_at == null && slot.is_active === 1)
              .sort((a, b) => a.sort_order - b.sort_order || a.starts_at.localeCompare(b.starts_at));
            return { results: items as unknown as T[] };
          }
          if (sql.includes('FROM event_slots s')) {
            const [event_id] = bound as [string];
            const items = (state.slots ?? [])
              .filter((s) => s.event_id === event_id && s.deleted_at == null)
              .map((s) => {
                const active_count = (state.bookings ?? []).filter(
                  (b) => (b as BookingRow & { slot_id?: string }).slot_id === s.id && (b.status === 'requested' || b.status === 'confirmed'),
                ).length;
                return { ...s, active_count };
              })
              .sort((a, b) =>
                a.sort_order !== b.sort_order
                  ? a.sort_order - b.sort_order
                  : a.starts_at.localeCompare(b.starts_at),
              );
            return { results: items as unknown as T[] };
          }
          if (sql.startsWith('SELECT * FROM event_slots WHERE id IN (')) {
            const ids = new Set(bound as string[]);
            return {
              results: (state.slots ?? []).filter((slot) => ids.has(slot.id)) as unknown as T[],
            };
          }
          // SELECT * FROM event_slots WHERE event_id = ? AND deleted_at IS NULL AND client_key IN (...)
          if (sql.startsWith('SELECT * FROM event_slots') && sql.includes('client_key IN (')) {
            const [event_id, ...keys] = bound as [string, ...string[]];
            const keySet = new Set(keys);
            return {
              results: (state.slots ?? []).filter(
                (slot) =>
                  slot.event_id === event_id &&
                  slot.deleted_at == null &&
                  keySet.has((slot as Record<string, unknown>).client_key as string),
              ) as unknown as T[],
            };
          }
          return { results: [] };
        },
        async run() {
          if (sql.includes('INSERT OR IGNORE INTO event_waitlist')) {
            const [
              id, line_account_id, event_id, slot_id, friend_id, identity_key,
              party_size, answer_snapshot_json, first_participation,
              first_participation_attended_count, first_participation_checked_at,
              event_version_id, event_snapshot_json,
              created_at, updated_at,
            ] = bound as string[];
            const dup = (state.waitlist ?? []).some(
              (w) => w.slot_id === slot_id && w.identity_key === identity_key,
            );
            if (dup) return { success: true, meta: { changes: 0 } };
            (state.waitlist ??= []).push({
              id,
              line_account_id,
              event_id,
              slot_id,
              friend_id,
              identity_key,
              status: 'waiting',
              party_size,
              answer_snapshot_json,
              first_participation,
              first_participation_attended_count,
              first_participation_checked_at,
              event_version_id,
              event_snapshot_json,
              created_at,
              updated_at,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_bookings') && sql.includes('internal_note = COALESCE')) {

            const [appended, _updated_at, id] = bound as [string, string, string];
            const b = (state.bookings ?? []).find((x) => x.id === id);
            if (!b) return { success: true, meta: { changes: 0 } };
            const cur = (b as Record<string, unknown>).internal_note as string | null;
            (b as Record<string, unknown>).internal_note = (cur ? cur + '\n' : '') + appended;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_bookings') && sql.includes('decided_at = ?, decided_by_staff_id')) {

            const [next, decided_at, decided_by, _updated_at, id] = bound as [string, string, string | null, string, string];
            const b = (state.bookings ?? []).find((x) => x.id === id);
            if (!b) return { success: true, meta: { changes: 0 } };
            b.status = next;
            (b as Record<string, unknown>).decided_at = decided_at;
            (b as Record<string, unknown>).decided_by_staff_id = decided_by;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_bookings') && sql.includes("status = 'cancelled'")) {

            const isFriend = sql.includes("cancelled_by = 'friend'");
            const [cancelled_at, _updated_at, id] = bound as [string, string, string];
            const b = (state.bookings ?? []).find((x) => x.id === id);
            if (!b) return { success: true, meta: { changes: 0 } };
            b.status = 'cancelled';
            (b as Record<string, unknown>).cancelled_at = cancelled_at;
            (b as Record<string, unknown>).cancelled_by = isFriend ? 'friend' : 'admin';
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_bookings SET ')) {
            // 状態を同時に変更されても上書きしないよう、id と元の状態を更新条件へ含める。
            const expectedStatus = bound[bound.length - 1] as string;
            const id = bound[bound.length - 2] as string;
            const b = (state.bookings ?? []).find((x) => x.id === id);
            if (!b) return { success: true, meta: { changes: 0 } };
            if (b.status !== expectedStatus) return { success: true, meta: { changes: 0 } };
            const setPart = sql.substring('UPDATE event_bookings SET '.length, sql.indexOf(' WHERE'));
            const cols = setPart.split(',').map((x) => x.trim());
            let valIdx = 0;
            for (const col of cols) {
              const m = /^(\w+)\s*=\s*(\?|strftime)/.exec(col);
              if (!m) continue;
              const colName = m[1];
              if (m[2] === '?') {
                if (colName === 'status') b.status = bound[valIdx] as string;
                else (b as Record<string, unknown>)[colName] = bound[valIdx];
                valIdx++;
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO event_bookings')) {
            const [
              id, line_account_id, event_id, slot_id, friend_id, status, customer_note,
              requested_at, identity_key, party_size, answer_snapshot_json,
              first_participation, first_participation_attended_count,
              first_participation_checked_at, event_version_id, event_snapshot_json,
              approval_expires_at,
            ] = bound as [
              string, string, string, string, string, string, string | null,
              string, string | undefined, number, string | null, number, number, string,
              string | null, string | null, string | null,
            ];
            (state.bookings ?? []).push({
              id, event_id, status,
              slot_id, friend_id,
              line_account_id,
              customer_note,
              identity_key,
              requested_at,
              party_size,
              answer_snapshot_json,
              first_participation,
              first_participation_attended_count,
              first_participation_checked_at,
              event_version_id,
              event_snapshot_json,
              approval_expires_at,
            } as BookingRow & Record<string, unknown>);
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO event_slots')) {
            const [
              id, event_id, starts_at, ends_at, capacity, is_active, sort_order, client_key,
            ] = bound as [string, string, string, string, number | null, number, number, string | null];
            (state.slots ?? []).push({
              id, event_id, starts_at, ends_at, capacity,
              is_active, sort_order, deleted_at: null,
              client_key: client_key ?? null,
              version: 1,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_slots SET deleted_at')) {
            const [deleted_at, _updated, id] = bound as [string, string, string];
            const s = (state.slots ?? []).find((x) => x.id === id);
            if (!s) return { success: true, meta: { changes: 0 } };
            s.deleted_at = deleted_at;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE event_slots SET ')) {
            // m26g: 条件付き更新（AND version = ?）を本番どおりに再現する。
            const conditionalVersion = sql.includes('AND version = ?');
            const id = bound[bound.length - (conditionalVersion ? 2 : 1)] as string;
            const s = (state.slots ?? []).find((x) => x.id === id);
            if (!s) return { success: true, meta: { changes: 0 } };
            if (conditionalVersion && (s.version ?? 1) !== bound[bound.length - 1]) {
              return { success: true, meta: { changes: 0 } };
            }
            const setPart = sql.substring('UPDATE event_slots SET '.length, sql.indexOf(' WHERE'));
            const cols = setPart.split(',').map((x) => x.trim());
            let valIdx = 0;
            for (const col of cols) {
              if (/^version\s*=\s*version\s*\+\s*1$/.test(col)) {
                s.version = ((s.version ?? 1) as number) + 1;
                continue;
              }
              const m = /^(\w+)\s*=\s*(\?|strftime)/.exec(col);
              if (!m) continue;
              const colName = m[1];
              if (m[2] === '?') {
                (s as Record<string, unknown>)[colName] = bound[valIdx];
                valIdx++;
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('INSERT INTO events')) {
            const [
              id, line_account_id, name, venue_name, venue_url, image_url,
              description, description_centered,
              max_bookings_per_friend, requires_approval, approval_deadline_hours, cancel_deadline_hours_before,
              reminder_day_before_enabled, reminder_hours_before,
              is_published, sort_order,
              target_type, account_ids, dedup_priority,
            ] = bound as [
              string, string, string, string | null, string | null, string | null,
              string | null, number,
              number | null, number, number, number | null,
              number, number | null,
              number, number,
              string, string | null, string | null,
            ];
            const now = new Date().toISOString();
            state.events.push({
              id,
              line_account_id,
              name,
              venue_name,
              venue_url,
              image_url,
              description,
              description_centered,
              max_bookings_per_friend,
              requires_approval,
              approval_deadline_hours,
              cancel_deadline_hours_before,
              reminder_day_before_enabled,
              reminder_hours_before,
              is_published,
              folder_id: null,
              sort_order,
              deleted_at: null,
              created_at: now,
              updated_at: now,
              target_type: target_type as 'single' | 'multi-account-dedup',
              account_ids,
              dedup_priority,
              questions_json: (bound[27] as string | null) ?? null,
              version: 1,
              current_published_version_id: (bound[28] as string | null) ?? null,
            });
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE events SET deleted_at')) {
            // 認可は handler 内で ownsEvent 経由で済んでいるので、ここでは
            // id + deleted_at IS NULL のみで一致させる。
            const [deleted_at, updated_at, id] = bound as [
              string, string, string,
            ];
            const e = state.events.find(
              (x) => x.id === id && x.deleted_at == null,
            );
            if (!e) return { success: true, meta: { changes: 0 } };
            e.deleted_at = deleted_at;
            e.updated_at = updated_at;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith('UPDATE events SET ')) {

            const conditionalVersion = sql.includes('AND version = ?');
            const conditionalToken = sql.includes('AND version_write_token = ?');
            const id = bound[bound.length - (conditionalToken ? 3 : conditionalVersion ? 2 : 1)] as string;
            const e = state.events.find((x) => x.id === id);
            if (!e) return { success: true, meta: { changes: 0 } };
            if (conditionalVersion && e.version !== bound[bound.length - 1]) {
              return { success: true, meta: { changes: 0 } };
            }

            const setPart = sql.substring('UPDATE events SET '.length, sql.indexOf(' WHERE'));
            const cols = setPart.split(',').map((s) => s.trim());
            let valIdx = 0;
            for (const col of cols) {
              if (/^version\s*=\s*version\s*\+\s*1$/.test(col)) {
                e.version += 1;
                continue;
              }
              const m = /^(\w+)\s*=\s*(\?|strftime)/.exec(col);
              if (!m) continue;
              const colName = m[1];
              if (m[2] === '?') {
                (e as Record<string, unknown>)[colName] = bound[valIdx];
                valIdx++;
              } else {
                e.updated_at = new Date().toISOString();
              }
            }
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
      };
      return stmt;
    },
    async batch(statements: D1PreparedStatement[]) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return db;
}

function setupApp(
  state: Parameters<typeof makeEventDb>[0],
  staffRole: 'owner' | 'admin' | 'staff' = 'owner',
  inspectDb?: (db:D1Database) => void,
) {
  state.accounts ??= [];
  for (const account of state.accounts) {
    account.tenant_id ??= 'tenant-a';
  }
  if (!state.accounts.some((account) => account.id === 'la1')) {
    state.accounts.push({
      id: 'la1',
      liff_id: 'liff-default',
      is_active: 1,
      tenant_id: 'tenant-a',
    });
  }
  const app = new Hono<TestEnv>();
  const db = makeEventDb(state);
  inspectDb?.(db);
  waitlistMocks.getEventOccurrenceUsedSeats.mockImplementation(
    async (_db: D1Database, slotId: string) => {
      const bookingSeats = (state.bookings ?? [])
        .filter((booking) => booking.slot_id === slotId && (booking.status === 'requested' || booking.status === 'confirmed'))
        .reduce((sum, booking) => sum + Number((booking as Record<string, unknown>).party_size ?? 1), 0);
      const heldSeats = (state.waitlist ?? [])
        .filter((entry) => entry.slot_id === slotId && (entry.status === 'offered' || entry.status === 'accepted'))
        .reduce((sum, entry) => sum + Number(entry.party_size ?? 1), 0);
      return bookingSeats + heldSeats;
    },
  );
  app.use('*', async (c, next) => {
    c.set('staff', { id: 'staff-1', role: staffRole, tenantId: 'tenant-a' } as never);
    c.env = { DB: db } as TestEnv['Bindings'];
    await next();
  });
  app.route('/', events);
  return app;
}

beforeEach(() => {
  for (const fn of Object.values(availabilityMocks)) fn.mockReset();
  for (const fn of Object.values(liffAuthMocks)) fn.mockReset();
  liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
  for (const fn of Object.values(idempotencyMocks)) fn.mockReset();
  for (const fn of Object.values(reminderMocks)) fn.mockReset();
  for (const fn of Object.values(notifierMocks)) fn.mockReset();
  for (const fn of Object.values(waitlistMocks)) fn.mockReset();
  for (const fn of Object.values(applicantSnapshotMocks)) fn.mockReset();
  reminderMocks.computeRemindersForBooking.mockReturnValue([]);
  waitlistMocks.createEventWaitlistOfferSender.mockReturnValue(vi.fn());
  waitlistMocks.enqueueEventWaitlistPromotion.mockResolvedValue(true);
  applicantSnapshotMocks.createEventApplicantSnapshot.mockImplementation(async (_db: D1Database, input: { data: unknown }) => ({
    id: 'snapshot-1', data: input.data, expiresAt: '2099-01-01T00:15:00.000Z',
  }));
});

describe('admin role guards (N-065 #623)', () => {
  const guardState = () => ({
    events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
    slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
    bookings: [
      { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
    ],
    friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
  });

  test('slot time change is owner/admin only (staff cannot reach it)', async () => {
    const body = { starts_at: '2099-06-03T10:00:00Z', ends_at: '2099-06-03T12:00:00Z' };
    const init = { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } as RequestInit;
    const denied = await setupApp(guardState(), 'staff')
      .request('/api/events/admin/events/e1/slots/s1?account_id=la1', init);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ success: false });
    const allowed = await setupApp(guardState(), 'owner')
      .request('/api/events/admin/events/e1/slots/s1?account_id=la1', init);
    expect(allowed.status).not.toBe(403);
  });

  test('booking decide/cancel/update allow staff (permission layer gates)', async () => {
    const staffApp = () => setupApp(guardState(), 'staff');
    const decide = await staffApp().request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'confirm' }),
    });
    expect(decide.status).not.toBe(403);
    const cancel = await staffApp().request('/api/events/admin/events/e1/bookings/b1/cancel?account_id=la1', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(cancel.status).not.toBe(403);
    const update = await staffApp().request('/api/events/admin/events/e1/bookings/b1?account_id=la1', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ internal_note: 'x' }),
    });
    expect(update.status).not.toBe(403);
  });
});

describe('admin account scope', () => {
  test('rejects an account outside the signed-in staff scope', async () => {
    const app = setupApp({
      events: [],
      accounts: [
        {
          id: 'other-account',
          liff_id: 'other-liff',
          is_active: 1,
          tenant_id: 'tenant-b',
        },
      ],
    });

    const res = await app.request('/api/events/admin/events?account_id=other-account');

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: 'このLINEアカウントを操作する権限がありません',
    });
  });
});

describe('POST /api/events/admin/events', () => {
  test('creates an event with required fields and defaults', async () => {
    const state = { events: [] as EventRow[] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AAA説明会' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EventRow;
    expect(body.name).toBe('AAA説明会');
    expect(body.line_account_id).toBe('la1');
    expect(body.is_published).toBe(0);
    expect(body.requires_approval).toBe(0);
    expect(body.reminder_day_before_enabled).toBe(1);
    expect(state.events).toHaveLength(1);
  });

  test('honors provided fields', async () => {
    const state = { events: [] as EventRow[] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        venue_name: '渋谷',
        venue_url: 'https://example.com',
        description: 'hello',
        description_centered: 1,
        max_bookings_per_friend: 1,
        requires_approval: 1,
        cancel_deadline_hours_before: 12,
        reminder_day_before_enabled: 0,
        reminder_hours_before: 2,
        is_published: 1,
        sort_order: 5,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EventRow;
    expect(body.requires_approval).toBe(1);
    expect(body.cancel_deadline_hours_before).toBe(12);
    expect(body.is_published).toBe(1);
  });

  test('400 when account_id missing', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    expect(res.status).toBe(400);
  });

  test('422 when name empty', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_name');
  });

  test('422 for blank name, waitlist_enabled=2, negative sort_order (点検#520軽14)', async () => {
    // 空白だけの名前は画面とDBの読みがずれる。waitlist_enabledは画面が `=== 1` で読む。
    for (const payload of [
      { name: '   ' },
      { name: 'X', waitlist_enabled: 2 },
      { name: 'X', sort_order: -1 },
    ]) {
      const app = setupApp({ events: [] });
      const res = await app.request('/api/events/admin/events?account_id=la1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      expect(res.status).toBe(422);
    }
  });

  test('422 when venue_url is not http(s) (点検#520の中5)', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', venue_url: 'javascript:alert(1)' }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_venue_url');
  });

  test('422 when name >255', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'a'.repeat(256) }),
    });
    expect(res.status).toBe(422);
  });

  test('422 when description >20000', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', description: 'a'.repeat(20001) }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_description');
  });

  test('422 when requires_approval is not 0/1', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', requires_approval: 2 }),
    });
    expect(res.status).toBe(422);
  });

  test('422 when cancel_deadline_hours_before is negative', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', cancel_deadline_hours_before: -1 }),
    });
    expect(res.status).toBe(422);
  });

  test('multi-account-dedup creates event with account_ids JSON', async () => {
    const state = {
      events: [] as EventRow[],
      accounts: [
        { id: 'la1', liff_id: 'liff1', is_active: 1, tenant_id: 'tenant-a' },
        { id: 'la2', liff_id: 'liff2', is_active: 1, tenant_id: 'tenant-a' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        target_type: 'multi-account-dedup',
        account_ids: ['la1', 'la2'],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as EventRow;
    expect(body.target_type).toBe('multi-account-dedup');
    expect(typeof body.account_ids === 'string' ? JSON.parse(body.account_ids) : body.account_ids).toEqual(['la1', 'la2']);
    // 複数アカウントの代表値は account_ids[0] と一致させる。
    expect(body.line_account_id).toBe('la1');
  });

  test('403 when one multi-account body account belongs to another tenant', async () => {
    const state = {
      events: [] as EventRow[],
      accounts: [
        { id: 'la1', liff_id: 'liff1', is_active: 1, tenant_id: 'tenant-a' },
        { id: 'la2', liff_id: 'liff2', is_active: 1, tenant_id: 'tenant-a' },
        { id: 'other', liff_id: 'liff3', is_active: 1, tenant_id: 'tenant-b' },
      ],
    };
    const res = await setupApp(state).request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'X', target_type: 'multi-account-dedup', account_ids: ['la1', 'other'],
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'このLINEアカウントを操作する権限がありません' });
    expect(state.events).toHaveLength(0);
  });

  test('422 invalid_target_type', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', target_type: 'bogus' }),
    });
    expect(res.status).toBe(422);
  });

  test('422 multi-account-dedup with empty account_ids', async () => {
    const app = setupApp({ events: [] });
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X', target_type: 'multi-account-dedup', account_ids: [] }),
    });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/events/admin/events', () => {
  test('lists events scoped to account', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', name: 'A' }),
        baseEvent({ id: 'e2', line_account_id: 'la1', name: 'B' }),
        baseEvent({ id: 'e3', line_account_id: 'la2', name: 'C' }),
      ],
      slots: [],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: EventRow[] };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((e) => e.id).sort()).toEqual(['e1', 'e2']);
  });

  test('lists includes multi-account event when account in account_ids', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', target_type: 'single', name: 'A' }),
        baseEvent({
          id: 'e2',
          line_account_id: 'la2',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la2', 'la1', 'la3']),
          name: 'B',
        }),
        baseEvent({
          id: 'e3',
          line_account_id: 'la3',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la3']),
          name: 'C',
        }),
      ],
      slots: [],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    const body = (await res.json()) as { items: EventRow[] };
    expect(body.items.map((x) => x.id).sort()).toEqual(['e1', 'e2']);
  });

  test('hides soft-deleted events', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', deleted_at: '2026-05-01T00:00:00Z' }),
        baseEvent({ id: 'e2', line_account_id: 'la1' }),
      ],
      slots: [],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    const body = (await res.json()) as { items: EventRow[] };
    expect(body.items.map((e) => e.id)).toEqual(['e2']);
  });

  test('returns the visible tag name for the 申込条件 column', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', visible_tag_id: 't1' }),
        baseEvent({ id: 'e2', line_account_id: 'la1', visible_tag_id: null }),
        baseEvent({ id: 'e3', line_account_id: 'la1', visible_tag_id: 'gone' }),
      ],
      slots: [],
      bookings: [],
      tags: [{ id: 't1', name: '定期便 契約中' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    const body = (await res.json()) as {
      items: Array<EventRow & { visible_tag_name: string | null }>;
    };
    const byId = new Map(body.items.map((e) => [e.id, e]));
    expect(byId.get('e1')?.visible_tag_name).toBe('定期便 契約中');
    // 絞り込み無しは名前も無い。一覧では「全員」と出る。
    expect(byId.get('e2')?.visible_tag_name).toBeNull();
    // タグを消しても events 側の ID は残る。名前が引けない状態＝もう誰にも
    // 見えないので、「全員」と同じ扱いにしてはいけない。
    expect(byId.get('e3')?.visible_tag_id).toBe('gone');
    expect(byId.get('e3')?.visible_tag_name).toBeNull();
  });

  test('returns aggregate columns for each item', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: 3, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', status: 'requested' },
        { id: 'b2', event_id: 'e1', status: 'confirmed' },
        { id: 'b3', event_id: 'e1', status: 'cancelled' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    const body = (await res.json()) as { items: Array<EventRow & { next_slot_starts_at: string | null; total_capacity: number | null; total_active: number; pending_count: number }> };
    const e = body.items[0];
    expect(e.next_slot_starts_at).toBe('2099-06-01T10:00:00Z');
    expect(e.total_capacity).toBe(8);
    expect(e.total_active).toBe(2);
    expect(e.pending_count).toBe(1);
  });

  test('total_capacity is null when an uncapped slot is mixed in (点検#520の中6)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1');
    const body = (await res.json()) as { items: Array<{ total_capacity: number | null }> };
    expect(body.items[0].total_capacity).toBeNull();
  });

  test('clamps limit and returns total (点検#520の中8)', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', name: 'A' }),
        baseEvent({ id: 'e2', line_account_id: 'la1', name: 'B' }),
        baseEvent({ id: 'e3', line_account_id: 'la1', name: 'C' }),
      ],
      slots: [],
      bookings: [],
    };
    const app = setupApp(state);
    const one = (await (await app.request('/api/events/admin/events?account_id=la1&limit=1')).json()) as {
      items: unknown[]; total: number; limit: number;
    };
    expect(one.items).toHaveLength(1);
    expect(one.total).toBe(3);
    const clamped = (await (await app.request('/api/events/admin/events?account_id=la1&limit=999')).json()) as {
      items: unknown[]; total: number; limit: number;
    };
    expect(clamped.limit).toBe(200);
    expect(clamped.items).toHaveLength(3);
    expect(clamped.total).toBe(3);
  });

  test('applies search, filter, sort, and page before returning the list', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1', name: 'Bravo meeting', is_published: 1 }),
        baseEvent({ id: 'e2', line_account_id: 'la1', name: 'Hidden meeting', is_published: 0 }),
        baseEvent({ id: 'e3', line_account_id: 'la1', name: 'Alpha meeting', is_published: 1 }),
      ],
      // 受付中のみは今後の枠がある行だけ。公開済みの行には枠を付ける。
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's3', event_id: 'e3', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
      ],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1&q=meeting&filter=open&sort=name&page=2&limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: EventRow[]; total: number; limit: number; sort: Array<{ field: string }> };
    expect(body.items.map((event) => event.id)).toEqual(['e1']);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.sort.map((item) => item.field)).toEqual(['name', 'id']);
  });

  test('summarizeFutureEventSlots counts only future slots with the same thresholds', () => {
    const now = Date.parse('2026-09-27T00:00:00.000Z');
    const iso = (days: number) => new Date(now + days * 24 * 60 * 60 * 1000).toISOString();
    const summary = summarizeFutureEventSlots([
      // 残り2席・3日後 → あと少しで満席。8割埋まりで「少ない」には入らない。
      { starts_at: iso(3), capacity: 10, active_count: 8 },
      // 8日後 → 7日以内ではないので「少ない」には入らない。
      { starts_at: iso(8), capacity: 10, active_count: 1 },
      // 翌日・2割 → 申し込みが少ない。
      { starts_at: iso(1), capacity: 10, active_count: 2 },
      // 定員なし → 定員合計は出さない。
      { starts_at: iso(2), capacity: null, active_count: 4 },
    ], now);
    expect(summary.upcoming_slots).toBe(4);
    expect(summary.upcoming_active).toBe(15);
    expect(summary.upcoming_capacity).toBeNull();
    expect(summary.fill_rate).toBeNull();
    expect(summary.nearly_full).toBe(1);
    expect(summary.low_applications).toBe(1);
    expect(summary.nearest_upcoming_starts_at).toBe(iso(1));
    expect(summary.nearest_low_starts_at).toBe(iso(1));
  });

  test('rejects unsupported list filters', async () => {
    const app = setupApp({ events: [] });
    expect((await app.request('/api/events/admin/events?account_id=la1&filter=unknown')).status).toBe(400);
    expect((await app.request('/api/events/admin/events?account_id=la1&sort=unknown')).status).toBe(400);
  });

  test('filter=open excludes published events with only past slots (R81)', async () => {
    const state = {
      events: [
        baseEvent({ id: 'open', line_account_id: 'la1', name: '受付中の会', is_published: 1 }),
        baseEvent({ id: 'ended', line_account_id: 'la1', name: '終わった会', is_published: 1 }),
        baseEvent({ id: 'draft', line_account_id: 'la1', name: '下書きの会', is_published: 0 }),
      ],
      slots: [
        { id: 's-open', event_id: 'open', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's-ended', event_id: 'ended', starts_at: '2020-06-01T10:00:00Z', ends_at: '2020-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's-draft', event_id: 'draft', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
      ],
      bookings: [],
    };
    const app = setupApp(state);
    const openBody = (await (await app.request('/api/events/admin/events?account_id=la1&filter=open')).json()) as { items: EventRow[] };
    expect(openBody.items.map((e) => e.id)).toEqual(['open']);
    const allBody = (await (await app.request('/api/events/admin/events?account_id=la1&filter=all')).json()) as { items: EventRow[] };
    expect(allBody.items.map((e) => e.id).sort()).toEqual(['draft', 'ended', 'open']);
  });

  test('summary counts future slots across all filtered events, not the page (R79/R80)', async () => {
    const events = [baseEvent({ id: 'e-pastfull', line_account_id: 'la1', name: '終わり満席の会', is_published: 1 })];
    for (let i = 1; i <= 21; i += 1) {
      events.push(baseEvent({ id: `e${i}`, line_account_id: 'la1', name: `未来の会${i}`, is_published: 1 }));
    }
    const slots = [
      // 終わった回は100席満席。今後の回は5席で申込なし。
      { id: 's-past', event_id: 'e-pastfull', starts_at: '2020-06-01T10:00:00Z', ends_at: '2020-06-01T12:00:00Z', capacity: 100, is_active: 1, sort_order: 0, deleted_at: null },
      { id: 's-future', event_id: 'e-pastfull', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 1, deleted_at: null },
    ];
    const bookings = [];
    for (let i = 0; i < 100; i += 1) {
      bookings.push({ id: `bp${i}`, event_id: 'e-pastfull', slot_id: 's-past', status: 'confirmed', party_size: 1 });
    }
    for (let i = 1; i <= 21; i += 1) {
      slots.push({ id: `s${i}`, event_id: `e${i}`, starts_at: '2099-07-01T10:00:00Z', ends_at: '2099-07-01T12:00:00Z', capacity: 10, is_active: 1, sort_order: 0, deleted_at: null });
      bookings.push({ id: `b${i}`, event_id: `e${i}`, slot_id: `s${i}`, status: 'confirmed', party_size: 1 });
    }
    const app = setupApp({ events, slots, bookings });
    const body = (await (await app.request('/api/events/admin/events?account_id=la1&limit=20')).json()) as {
      items: unknown[]; total: number; summary: Record<string, number | string | null>;
    };
    // 1ページは20件だが、集計は絞り込みに合う全22イベントの今後の枠22枠。
    expect(body.items).toHaveLength(20);
    expect(body.total).toBe(22);
    expect(body.summary.upcoming_slots).toBe(22);
    // 終わった回の100席は含まない。今後は5席+21枠×10席=215席、申込は21人。
    expect(body.summary.upcoming_capacity).toBe(215);
    expect(body.summary.upcoming_active).toBe(21);
  });
});

describe('GET /api/events/admin/events/:id', () => {
  test('returns event when account matches', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1');
    expect(res.status).toBe(200);
  });

  test('404 when event belongs to other account', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la2' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1');
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/events/admin/events/:id', () => {
  test('updates only provided fields', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', name: 'old', requires_approval: 0 })],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'new', requires_approval: 1, expected_version: 1 }),
    });
    expect(res.status).toBe(200);
    expect(state.events[0].name).toBe('new');
    expect(state.events[0].requires_approval).toBe(1);
  });

  test('404 for cross-account update', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la2' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', expected_version: 1 }),
    });
    expect(res.status).toBe(404);
  });

  test('403 when an update adds one account from another tenant', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      accounts: [
        { id: 'la1', liff_id: 'liff1', is_active: 1, tenant_id: 'tenant-a' },
        { id: 'other', liff_id: 'liff2', is_active: 1, tenant_id: 'tenant-b' },
      ],
    };
    const res = await setupApp(state).request('/api/events/admin/events/e1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target_type: 'multi-account-dedup', account_ids: ['la1', 'other'], expected_version: 1,
      }),
    });
    expect(res.status).toBe(403);
    expect(state.events[0].target_type).not.toBe('multi-account-dedup');
  });

  test('422 invalid description', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'x'.repeat(20001), expected_version: 1 }),
    });
    expect(res.status).toBe(422);
  });
});

describe('DELETE /api/events/admin/events/:id', () => {
  test('soft deletes', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(state.events[0].deleted_at).not.toBeNull();
  });

  test('404 for cross-account', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la2' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});

describe('event_slots admin', () => {
  test('GET occurrence-selector returns only active owned slots without booking aggregates', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's-active', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 1, deleted_at: null },
        { id: 's-inactive', event_id: 'e1', starts_at: '2099-06-01T13:00:00Z', ends_at: '2099-06-01T15:00:00Z', capacity: 5, is_active: 0, sort_order: 0, deleted_at: null },
      ],
    };
    const res = await setupApp(state).request('/api/events/admin/events/e1/occurrence-selector?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Pick<SlotRow, 'id' | 'event_id' | 'starts_at' | 'ends_at' | 'capacity' | 'is_active' | 'sort_order'>> };
    expect(body.items).toEqual([expect.objectContaining({ id: 's-active', event_id: 'e1' })]);
    expect(body.items[0]).not.toHaveProperty('active_count');
  });

  test('GET occurrence-selector hides a cross-account event', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la2' })], slots: [] };
    const res = await setupApp(state).request('/api/events/admin/events/e1/occurrence-selector?account_id=la1');
    expect(res.status).toBe(404);
  });

  test('GET /:id/slots returns slots with active_count', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', status: 'confirmed' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<SlotRow & { active_count: number }> };
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe('s1');
    expect(body.items[0].active_count).toBe(1);
    expect(body.items[1].active_count).toBe(0);
  });

  test('GET 404 for cross-account event', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la2' })] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1');
    expect(res.status).toBe(404);
  });

  test('POST creates multiple slots', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [] as SlotRow[],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [
          { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5 },
          { starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: null },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: SlotRow[] };
    expect(body.items).toHaveLength(2);
    expect(state.slots).toHaveLength(2);
  });

  test('POST rejects more than 400 slots before inserting any', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [] as SlotRow[] };
    const slots = Array.from({ length: 401 }, (_, index) => ({
      starts_at: `2099-06-${String((index % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      ends_at: `2099-06-${String((index % 28) + 1).padStart(2, '0')}T11:00:00Z`,
      sort_order: index,
    }));
    const res = await setupApp(state).request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slots }),
    });
    expect(res.status).toBe(422);
    expect(state.slots).toHaveLength(0);
  });

  test('POST atomically creates 400 slots and preserves request order', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [] as SlotRow[] };
    const slots = Array.from({ length: 400 }, (_, index) => ({
      starts_at: new Date(Date.UTC(2099, 0, 1, 0, index)).toISOString(),
      ends_at: new Date(Date.UTC(2099, 0, 1, 0, index + 1)).toISOString(),
      sort_order: index,
    }));
    const res = await setupApp(state).request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slots }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: SlotRow[] };
    expect(state.slots).toHaveLength(400);
    expect(body.items).toHaveLength(400);
    expect(body.items.map((item) => item.starts_at)).toEqual(slots.map((slot) => slot.starts_at));
  });

  //  client_key で再送を吸収する。400+1の分割送信が
  // 後半だけ失敗しても、同じキーでの再送は成功済みの枠を増やさない。
  test('POST re-sends with the same client_key do not duplicate slots', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [] as SlotRow[],
    };
    const app = setupApp(state);
    const body = {
      slots: [
        { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z', capacity: 5, client_key: 'op-1:0' },
        { starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T11:00:00Z', capacity: 5, client_key: 'op-1:1' },
      ],
    };
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    const first = await app.request('/api/events/admin/events/e1/slots?account_id=la1', init);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { items: SlotRow[]; created_count: number; deduplicated_count: number };
    expect(firstBody.created_count).toBe(2);
    expect(firstBody.deduplicated_count).toBe(0);
    const firstIds = firstBody.items.map((item) => item.id);

    // 応答喪失や部分失敗を想定した、同じキーの全件再送。
    const second = await app.request('/api/events/admin/events/e1/slots?account_id=la1', init);
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { items: Array<SlotRow & { deduplicated?: boolean }>; created_count: number; deduplicated_count: number };
    expect(state.slots).toHaveLength(2);
    expect(secondBody.created_count).toBe(0);
    expect(secondBody.deduplicated_count).toBe(2);
    // 再送でも同じ枠IDが返る(画面側が成功済みを確定できる)。
    expect(secondBody.items.map((item) => item.id)).toEqual(firstIds);
    expect(secondBody.items.every((item) => item.deduplicated === true)).toBe(true);
  });

  test('POST client_key dedup keeps legitimate same-time slots possible', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [] as SlotRow[],
    };
    const app = setupApp(state);
    // 日時の一意制約ではないので、キーが違う同時刻の枠は両方作れる。
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [
          { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z', client_key: 'op-2:0' },
          { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z', client_key: 'op-2:1' },
          { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect(state.slots).toHaveLength(3);
  });

  test('POST duplicate client_key within one request resolves to the same slot', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [] as SlotRow[],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [
          { starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z', client_key: 'op-3:0' },
          { starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T11:00:00Z', client_key: 'op-3:0' },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { items: Array<SlotRow & { deduplicated?: boolean }>; created_count: number; deduplicated_count: number };
    expect(state.slots).toHaveLength(1);
    expect(body.items).toHaveLength(2);
    expect(body.items[0].id).toBe(body.items[1].id);
    expect(body.created_count).toBe(1);
    expect(body.deduplicated_count).toBe(1);
  });

  test('POST 422 for invalid client_key', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [] as SlotRow[],
    };
    const res = await setupApp(state).request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [{ starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T11:00:00Z', client_key: 'x'.repeat(201) }],
      }),
    });
    expect(res.status).toBe(422);
    expect(state.slots).toHaveLength(0);
  });

  test('POST 422 when slots empty', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slots: [] }),
    });
    expect(res.status).toBe(422);
  });

  test('POST 422 when starts_at >= ends_at', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [{ starts_at: '2099-06-01T12:00:00Z', ends_at: '2099-06-01T10:00:00Z' }],
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('invalid_slot_range');
  });

  test('POST 422 when capacity invalid', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slots: [{ starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 0 }],
      }),
    });
    expect(res.status).toBe(422);
  });

  test('PUT updates slot fields', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: 10, is_active: 0, expected_version: 1 }),
    });
    expect(res.status).toBe(200);
    expect(state.slots[0].capacity).toBe(10);
    expect(state.slots[0].is_active).toBe(0);
  });

  test('PUT 422 when range becomes invalid (only ends_at provided)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ends_at: '2099-06-01T09:00:00Z', expected_version: 1 }),
    });
    expect(res.status).toBe(422);
  });

  test('PUT 409 when shrinking capacity below used seats (点検#520の中4)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', status: 'confirmed', party_size: 2 },
        { id: 'b2', event_id: 'e1', slot_id: 's1', status: 'requested', party_size: 1 },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: 2, expected_version: 1 }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('slot_capacity_below_bookings');
    expect(state.slots[0].capacity).toBe(5);
  });

  test('PUT allows shrinking capacity to exactly used seats (点検#520の中4)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', status: 'confirmed', party_size: 2 },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capacity: 2, expected_version: 1 }),
    });
    expect(res.status).toBe(200);
    expect(state.slots[0].capacity).toBe(2);
  });

  test('DELETE soft-deletes when no active bookings', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(state.slots[0].deleted_at).not.toBeNull();
  });

  test('DELETE 409 when active bookings exist', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', status: 'confirmed' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('slot_has_bookings');
    expect(state.slots[0].deleted_at).toBeNull();
  });

  test('DELETE 204 when only cancelled bookings exist', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', status: 'cancelled' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/slots/s1?account_id=la1', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
  });
});

describe('LIFF event detail', () => {
  test('GET returns published event', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(200);
  });

  test('GET 404 when not published', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 0 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(404);
  });

  test('GET 404 when soft-deleted', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, deleted_at: '2026-05-01T00:00:00Z' })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(404);
  });

  test('GET 400 when liffId missing', async () => {
    const state = { events: [], accounts: [] };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1');
    expect(res.status).toBe(400);
  });

  test('GET 400 when liffId not resolvable', async () => {
    const state = { events: [], accounts: [] };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=unknown');
    expect(res.status).toBe(400);
  });

  test('GET 404 when event belongs to another account (cross-tenant block)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la2', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(404);
  });

  test('GET multi-account event 404 when caller account not in account_ids', async () => {
    const state = {
      events: [
        baseEvent({
          id: 'e1',
          line_account_id: 'la2',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la2', 'la3']),
          is_published: 1,
        }),
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(404);
  });

  test('GET multi-account event 200 when caller account in account_ids', async () => {
    const state = {
      events: [
        baseEvent({
          id: 'e1',
          line_account_id: 'la1',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la1', 'la2']),
          is_published: 1,
        }),
      ],
      accounts: [{ id: 'la2', liff_id: 'L2', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L2');
    expect(res.status).toBe(200);
  });

  test('GET includes my_existing_booking when friend already has active booking', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed', identity_key: 'uid:U1-uuid' } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1', user_id: 'U1-uuid' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { my_existing_booking: { id: string; status: string } | null };
    expect(body.my_existing_booking?.id).toBe('b1');
    expect(body.my_existing_booking?.status).toBe('confirmed');
  });

  test('GET my_existing_booking is null when caller has no booking', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1', user_id: 'U1-uuid' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    const body = (await res.json()) as { my_existing_booking: null };
    expect(body.my_existing_booking).toBeNull();
  });
});

describe('LIFF event slots', () => {
  test('GET returns slots from getSlotsWithRemaining', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    availabilityMocks.getSlotsWithRemaining.mockResolvedValue([
      { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, active_count: 1, remaining: 4 },
    ]);
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/slots?liffId=L1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; remaining: number }> };
    expect(body.items[0].remaining).toBe(4);
    expect(availabilityMocks.getSlotsWithRemaining).toHaveBeenCalledWith(
      expect.anything(),
      'e1',
      { only_active: true, only_future: true },
    );
  });

  test('GET 404 when event not published', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 0 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/slots?liffId=L1');
    expect(res.status).toBe(404);
    expect(availabilityMocks.getSlotsWithRemaining).not.toHaveBeenCalled();
  });
});

describe('LIFF POST /api/liff/events/:id/bookings', () => {
  test('creates confirmed booking when requires_approval=0', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, requires_approval: 0 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe('confirmed');
    expect(state.bookings).toHaveLength(1);
    expect(reminderMocks.computeRemindersForBooking).toHaveBeenCalled();
    expect(notifierMocks.sendEventBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'received_confirmed' }),
    );
    expect(idempotencyMocks.finalizeEventIdempotencyResponse).toHaveBeenCalled();
  });

  test('creates requested booking when requires_approval=1', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, requires_approval: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('requested');
    expect(reminderMocks.computeRemindersForBooking).not.toHaveBeenCalled();
    expect(notifierMocks.sendEventBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'received_pending' }),
    );
  });

  test('returns idempotent cached response on repeat', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 5, is_active: 1, sort_order: 0, deleted_at: null }],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'cached', status: 201, body: { id: 'cached', status: 'confirmed' } });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe('cached');
  });

  test('401 when Authorization missing', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(401);
  });

  test('400 when Idempotency-Key missing', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(400);
  });

  test('409 slot_full when capacity reached', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 1, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'fx', status: 'confirmed' } as BookingRow],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('slot_full');
  });

  test('409 over_friend_limit when max_bookings_per_friend (>1) reached', async () => {
    // max=2 で同一 identity_key の既存 2 件 → 3 件目で over_friend_limit
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, max_bookings_per_friend: 2 })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed', identity_key: 'uid:U1-uuid' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's2', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed', identity_key: 'uid:U1-uuid' } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1', user_id: 'U1-uuid' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('over_friend_limit');
  });

  test('410 slot_started for past slot', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2000-01-01T00:00:00Z', ends_at: '2000-01-01T02:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(410);
  });

  test('422 customer_note over 5000 chars', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1', customer_note: 'a'.repeat(5001) }),
    });
    expect(res.status).toBe(422);
  });

  test('409 duplicate_friend_booking when same identity_key already booked (cross-account)', async () => {
    const state = {
      events: [
        baseEvent({
          id: 'e1',
          line_account_id: 'la1',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la1', 'la2']),
          // max=null は「制限なし」。重複検知を働かせるには 1 を明示する。
          max_bookings_per_friend: 1,
          is_published: 1,
        }),
      ],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        // 同一人物 (uid:U1-uuid) が別アカ la2 経由で既予約
        { id: 'b-old', event_id: 'e1', slot_id: 's1', friend_id: 'f-la2', line_account_id: 'la2', status: 'confirmed', identity_key: 'uid:U1-uuid' } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f-la1', line_account_id: 'la1', line_user_id: 'U1', user_id: 'U1-uuid' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1', 'Authorization': 'Bearer t' },
      body: JSON.stringify({ slot_id: 's1' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; existing?: { id: string } };
    expect(body.error).toBe('duplicate_friend_booking');
    expect(body.existing?.id).toBe('b-old');
  });
});

describe('LIFF GET /api/liff/events/me', () => {
  test('upcoming returns only active future bookings', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, name: 'X' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2000-01-01T10:00:00Z', ends_at: '2000-01-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's2', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b3', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'cancelled' } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me?liffId=L1&tab=upcoming', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id)).toEqual(['b1']);
  });

  test('past returns cancelled and past confirmed', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2000-01-01T10:00:00Z', ends_at: '2000-01-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's2', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b3', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'cancelled' } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me?liffId=L1&tab=past', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id).sort()).toEqual(['b2', 'b3']);
  });

  test('returns empty when friend not registered', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  test('401 unauthorized', async () => {
    const state = { events: [], accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }] };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me?liffId=L1');
    expect(res.status).toBe(401);
  });
});

describe('LIFF GET /api/liff/events/me/:bookingId', () => {
  test('returns booking detail for owner friend', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, name: 'テストイベント' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; event_name: string };
    expect(body.id).toBe('b1');
    expect(body.event_name).toBe('テストイベント');
  });

  test('404 for cross-friend booking access', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  test('404 for non-existent booking id', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1 })],
      slots: [],
      bookings: [],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/nonexistent?liffId=L1', {
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });

  test('401 unauthorized', async () => {
    const state = { events: [], accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }] };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue(null);
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1?liffId=L1');
    expect(res.status).toBe(401);
  });
});

describe('LIFF POST /api/liff/events/me/:bookingId/cancel', () => {
  test('R83: 本人取消は期限内に予約を止め、自動案内の仕事を1件積む', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, cancel_deadline_hours_before: 24 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1/cancel?liffId=L1', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('cancelled');
    expect(reminderMocks.cancelPendingRemindersFor).toHaveBeenCalledWith(expect.anything(), 'b1');
    expect(waitlistMocks.enqueueEventWaitlistPromotion).toHaveBeenCalledTimes(1);
    expect(waitlistMocks.enqueueEventWaitlistPromotion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        lineAccountId: 'la1', eventId: 'e1', occurrenceId: 's1',
        sourceKey: 'booking:b1:cancelled',
      }),
    );
  });

  test('403 cancel_not_allowed when cancel_deadline_hours_before is null', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, cancel_deadline_hours_before: null })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1/cancel?liffId=L1', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(403);
  });

  test('409 cancel_deadline_passed when too late', async () => {
    const soonMs = Date.now() + 60_000; // 現在から1分後にする。
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, cancel_deadline_hours_before: 24 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(soonMs).toISOString(), ends_at: new Date(soonMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1/cancel?liffId=L1', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(409);
  });

  test('200 retry for already-cancelled booking repairs instead of 409 (N-065)', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, cancel_deadline_hours_before: 24 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'cancelled' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1/cancel?liffId=L1', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' },
    });
    // 取消が投げた直後の再送は、業務が済みでも だけ直して 200 を返す。
    expect(res.status).toBe(200);
  });

  test('404 cross-friend cancel', async () => {
    const futureMs = Date.now() + 7 * 24 * 3600_000;
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', is_published: 1, cancel_deadline_hours_before: 24 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: new Date(futureMs).toISOString(), ends_at: new Date(futureMs + 7200_000).toISOString(), capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/me/b1/cancel?liffId=L1', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer t' },
    });
    expect(res.status).toBe(404);
  });
});

describe('admin bookings management', () => {
  test('GET /:id/bookings aggregates multi-account bookings with line_account_id', async () => {
    const state = {
      events: [
        baseEvent({
          id: 'e1',
          line_account_id: 'la1',
          target_type: 'multi-account-dedup',
          account_ids: JSON.stringify(['la1', 'la2']),
        }),
      ],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f-la1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f-la2', line_account_id: 'la2', status: 'confirmed' } as BookingRow & Record<string, unknown>,
      ],
      friends: [
        { id: 'f-la1', line_account_id: 'la1', line_user_id: 'U1' },
        { id: 'f-la2', line_account_id: 'la2', line_user_id: 'U2' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; line_account_id: string }> };
    expect(body.items).toHaveLength(2);
    expect(body.items.map((x) => x.line_account_id).sort()).toEqual(['la1', 'la2']);
  });

  test('GET /:id/bookings filters by status and slot', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: null, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's2', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b3', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'cancelled' } as BookingRow & Record<string, unknown>,
      ],
      friends: [
        { id: 'f1', line_account_id: 'la1', line_user_id: 'U1' },
        { id: 'f2', line_account_id: 'la1', line_user_id: 'U2' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings?account_id=la1&status=requested');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id)).toEqual(['b1']);
  });

  test('GET /:id/bookings returns total and honors limit (点検#520の中8)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
      ],
      friends: [
        { id: 'f1', line_account_id: 'la1', line_user_id: 'U1' },
        { id: 'f2', line_account_id: 'la1', line_user_id: 'U2' },
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings?account_id=la1&limit=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number; limit: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
  });

  test('GET /:id/bookings returns the requested page', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 2, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
      ],
      friends: [],
    };
    const body = (await (await setupApp(state).request('/api/events/admin/events/e1/bookings?account_id=la1&page=2&limit=1')).json()) as { items: Array<{ id: string }>; total: number };
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(2);
  });

  test('GET /:id/bookings attaches each booking reminder schedule incl. stopped ones (IDEA-07)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'cancelled' } as BookingRow & Record<string, unknown>,
      ],
      friends: [
        { id: 'f1', line_account_id: 'la1', line_user_id: 'U1' },
        { id: 'f2', line_account_id: 'la1', line_user_id: 'U2' },
      ],
      reminders: [
        { id: 'r1', booking_id: 'b1', kind: 'day_before', scheduled_at: '2099-05-31T09:00:00Z', sent_at: null, status: 'pending' },
        { id: 'r2', booking_id: 'b1', kind: 'hours_before', scheduled_at: '2099-06-01T08:00:00Z', sent_at: null, status: 'pending' },
        // 取消済みの予約には「止まった分」が残る。古い通知が生きたままかを
        // 一覧から確かめられるよう、cancelled も応答に含める。
        { id: 'r3', booking_id: 'b2', kind: 'day_before', scheduled_at: '2099-05-31T09:00:00Z', sent_at: null, status: 'cancelled' },
        // 別予約の通知は混ざらない。
        { id: 'r9', booking_id: 'bx', kind: 'day_before', scheduled_at: '2099-05-30T09:00:00Z', sent_at: null, status: 'pending' },
      ],
    };
    const reminderReads: unknown[][] = [];
    const app = setupApp(state,'owner',db=>{
      const prepare=db.prepare.bind(db);
      db.prepare=(sql:string)=>{
        const statement=prepare(sql);
        if(!/FROM event_booking_reminders\b/.test(sql))return statement;
        const bind=statement.bind.bind(statement);
        statement.bind=(...args:unknown[])=>{
          reminderReads.push(args.flatMap(value=>typeof value==='string'&&value.startsWith('[')?JSON.parse(value) as unknown[]:[value]));
          return bind(...args);
        };
        return statement;
      };
    });
    const res = await app.request('/api/events/admin/events/e1/bookings?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        reminders: Array<{ kind: string; status: string; scheduled_at: string }>;
      }>;
    };
    expect(reminderReads).toHaveLength(1);
    expect([...reminderReads[0]].sort()).toEqual(body.items.map(item=>item.id).sort());
    const b1 = body.items.find((item) => item.id === 'b1');
    const b2 = body.items.find((item) => item.id === 'b2');
    expect(b1?.reminders.map((reminder) => reminder.kind)).toEqual(['day_before', 'hours_before']);
    expect(b1?.reminders.every((reminder) => reminder.status === 'pending')).toBe(true);
    expect(b2?.reminders).toEqual([
      expect.objectContaining({ kind: 'day_before', status: 'cancelled' }),
    ]);
    const page=await app.request('/api/events/admin/events/e1/bookings?account_id=la1&page=2&limit=1');
    const pageBody=await page.json<{items:Array<{id:string;reminders:unknown[]}>}>();
    expect(pageBody.items).toHaveLength(1);
    expect(reminderReads).toHaveLength(2); // 2回のHTTPにつき各1問。行ごとの取得にしない。
    expect(reminderReads[1]).toEqual([pageBody.items[0].id]);
  });

  test('GET /:id/bookings/summary returns all-status counts and capacity without list rows', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [
        { id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 3, is_active: 1, sort_order: 0, deleted_at: null },
        { id: 's2', event_id: 'e1', starts_at: '2099-06-02T10:00:00Z', ends_at: '2099-06-02T12:00:00Z', capacity: 2, is_active: 1, sort_order: 1, deleted_at: null },
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', status: 'requested', party_size: 2 },
        { id: 'b2', event_id: 'e1', status: 'confirmed', party_size: 1 },
        { id: 'b3', event_id: 'e1', status: 'cancelled', party_size: 4 },
      ],
      waitlist: [
        { id: 'w1', event_id: 'e1', status: 'waiting', party_size: 3 },
        { id: 'w2', event_id: 'e1', status: 'cancelled', party_size: 5 },
        { id: 'w3', event_id: 'e1', status: 'offered', party_size: 2 },
      ],
    };
    const res = await setupApp(state).request('/api/events/admin/events/e1/bookings/summary?account_id=la1');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      total: 3,
      requested: 1,
      confirmed: 1,
      cancelled: 1,
      waitlist: 2,
      totalCapacity: 5,
      // 席(人数)の内訳。待機中は席を消費せず、
      // 案内中・受諾済みだけを残席の計算へ入れる。
      requestedSeats: 2,
      confirmedSeats: 1,
      waitingSeats: 3,
      offeredSeats: 2,
      activeSeats: 5,
    });
  });

  test('GET /:id/bookings/summary returns zeros for no applications and hides another account event', async () => {
    const state = { events: [baseEvent({ id: 'e1', line_account_id: 'la1' })], slots: [], bookings: [] };
    const app = setupApp(state);
    const empty = await app.request('/api/events/admin/events/e1/bookings/summary?account_id=la1');
    expect(await empty.json()).toMatchObject({ total: 0, requested: 0, confirmed: 0, waitlist: 0, totalCapacity: null });
    const hidden = await app.request('/api/events/admin/events/e1/bookings/summary?account_id=la2');
    expect(hidden.status).toBe(403);
  });

  test('POST decide confirm transitions to confirmed and creates reminders', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1', reminder_day_before_enabled: 1, reminder_hours_before: 2 })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('confirmed');
    expect(reminderMocks.computeRemindersForBooking).toHaveBeenCalled();
    expect(notifierMocks.sendEventBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'confirmed' }),
    );
  });

  test('POST decide reject transitions to rejected and appends reason to internal_note', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reject', reason: '定員満員' }),
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('rejected');
    expect((state.bookings[0] as Record<string, unknown>).internal_note).toContain('定員満員');
    expect(notifierMocks.sendEventBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rejected' }),
    );
    expect(waitlistMocks.enqueueEventWaitlistPromotion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKey: 'booking:b1:rejected', occurrenceId: 's1' }),
    );
  });

  test('POST decide returns 409 already_decided', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed', decided_at: '2026-05-09T00:00:00Z' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('already_decided');
  });

  test('POST decide confirm refuses when the slot is already full (点検#520の中3)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 2, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested', party_size: 1 } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'confirmed', party_size: 2 } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
      friends: [],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.error).toBe('slot_full');
    expect(state.bookings[0].status).toBe('requested');
  });

  test('POST decide confirm passes when seats remain (点検#520の中3)', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: 2, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested', party_size: 1 } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e1', slot_id: 's1', friend_id: 'f2', line_account_id: 'la1', status: 'confirmed', party_size: 1 } as BookingRow & Record<string, unknown>,
      ],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/decide?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'confirm' }),
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('confirmed');
  });

  test('R83: 管理者取消は予約を止め、自動案内の仕事を1件積む', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
      accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' }],
      friends: [{ id: 'f1', line_account_id: 'la1', line_user_id: 'U1' }],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1/cancel?account_id=la1', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('cancelled');
    expect((state.bookings[0] as Record<string, unknown>).cancelled_by).toBe('admin');
    expect(reminderMocks.cancelPendingRemindersFor).toHaveBeenCalled();
    expect(waitlistMocks.enqueueEventWaitlistPromotion).toHaveBeenCalledTimes(1);
    expect(waitlistMocks.enqueueEventWaitlistPromotion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sourceKey: 'booking:b1:cancelled', occurrenceId: 's1' }),
    );
    expect(notifierMocks.sendEventBookingNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'cancelled_by_admin' }),
    );
  });

  test('PUT internal_note update', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ internal_note: 'check VIP' }),
    });
    expect(res.status).toBe(200);
    expect((state.bookings[0] as Record<string, unknown>).internal_note).toBe('check VIP');
  });

  test('PUT status=attended transitions confirmed→attended', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(200);
    expect(state.bookings[0].status).toBe('attended');
  });

  test('PUT status=no_show on requested booking returns 409', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
      slots: [{ id: 's1', event_id: 'e1', starts_at: '2099-06-01T10:00:00Z', ends_at: '2099-06-01T12:00:00Z', capacity: null, is_active: 1, sort_order: 0, deleted_at: null }],
      bookings: [{ id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1/bookings/b1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'no_show' }),
    });
    expect(res.status).toBe(409);
  });

  test('GET notifications/pending counts requested across the account', async () => {
    const state = {
      events: [
        baseEvent({ id: 'e1', line_account_id: 'la1' }),
        baseEvent({ id: 'e2', line_account_id: 'la1' }),
        baseEvent({ id: 'e3', line_account_id: 'la2' }),
      ],
      bookings: [
        { id: 'b1', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b2', event_id: 'e2', slot_id: 's2', friend_id: 'f1', line_account_id: 'la1', status: 'requested' } as BookingRow & Record<string, unknown>,
        { id: 'b3', event_id: 'e1', slot_id: 's1', friend_id: 'f1', line_account_id: 'la1', status: 'confirmed' } as BookingRow & Record<string, unknown>,
        { id: 'b4', event_id: 'e3', slot_id: 's3', friend_id: 'f3', line_account_id: 'la2', status: 'requested' } as BookingRow & Record<string, unknown>,
      ],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/notifications/pending?account_id=la1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number };
    expect(body.count).toBe(2);
  });
});

describe('occurrence applicants / waitlist promotion routes', () => {
  const state = {
    events: [baseEvent({ id: 'e1', line_account_id: 'la1' })],
    accounts: [{ id: 'la1', liff_id: 'L1', is_active: 1 }],
  };

  test('normal / empty: 申込者データを包んで返し、空配列を成功として保つ', async () => {
    waitlistMocks.getEventOccurrenceApplicants.mockResolvedValueOnce({
      occurrence: { id: 's1', eventId: 'e1', startsAt: '2099-01-01', endsAt: '2099-01-02', capacity: 2, activeSeats: 1, version: 1 },
      summary: { bookingCount: 1, waitingCount: 0, activeSeats: 1 },
      applicants: [{ source: 'booking', id: 'b1', friendId: 'f1' }],
    });
    const app = setupApp(structuredClone(state));
    const normal = await app.request('/api/events/admin/occurrences/s1/applicants?account_id=la1');
    expect(normal.status).toBe(200);
    await expect(normal.json()).resolves.toMatchObject({
      success: true,
      data: { occurrence: { id: 's1', version: 1 }, applicants: [{ id: 'b1' }], snapshotId: 'snapshot-1' },
    });
    expect(waitlistMocks.getEventOccurrenceApplicants).toHaveBeenCalledWith(
      expect.anything(),
      { occurrenceId: 's1', lineAccountId: 'la1' },
    );

    waitlistMocks.getEventOccurrenceApplicants.mockResolvedValueOnce({
      occurrence: { id: 's2', eventId: 'e1', startsAt: '2099-01-01', endsAt: '2099-01-02', capacity: 2, activeSeats: 0, version: 1 },
      summary: { bookingCount: 0, waitingCount: 0, activeSeats: 0 },
      applicants: [],
    });
    const empty = await app.request('/api/events/admin/occurrences/s2/applicants?account_id=la1');
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toMatchObject({ success: true, data: { applicants: [] } });
  });

  test('CSVは表示時の全申込者snapshotを、所属アカウントだけから書き出す', async () => {
    const snapshotData = {
      occurrence: { id: 's1', eventId: 'e1', startsAt: '2099-01-01', endsAt: '2099-01-02', capacity: 2, activeSeats: 1, version: 1 },
      summary: { bookingCount: 1, waitingCount: 1, activeSeats: 1 },
      applicants: [
        { source: 'booking', id: 'b1', friendId: 'f1', displayName: '=式にしない', status: 'confirmed', partySize: 1, appliedAt: '2099-01-01T00:00:00.000Z', offerExpiresAt: null },
        { source: 'waitlist', id: 'w1', friendId: 'f2', displayName: '待機者', status: 'offered', partySize: 2, appliedAt: '2099-01-01T01:00:00.000Z', offerExpiresAt: '2099-01-02T00:00:00.000Z' },
      ],
    };
    applicantSnapshotMocks.getEventApplicantSnapshot.mockResolvedValueOnce({
      kind: 'found', snapshot: { id: 'snapshot-1', data: snapshotData, expiresAt: '2099-01-01T00:15:00.000Z' },
    });
    const app = setupApp(structuredClone(state));
    const csv = await app.request('/api/events/admin/occurrences/s1/applicants.csv?account_id=la1&snapshot_id=snapshot-1');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    await expect(csv.text()).resolves.toContain("'=式にしない");
    expect(applicantSnapshotMocks.getEventApplicantSnapshot).toHaveBeenCalledWith(
      expect.anything(), { id: 'snapshot-1', lineAccountId: 'la1', occurrenceId: 's1', staffId: 'staff-1' },
    );

    waitlistMocks.getEventOccurrenceApplicants.mockResolvedValueOnce(null);
    const outside = await app.request('/api/events/admin/occurrences/s1/applicants.csv?account_id=other&snapshot_id=snapshot-1');
    expect(outside.status).toBe(403);
  });

  test('CSVは期限切れ・別担当者のsnapshotを再読込せず拒否する', async () => {
    const app = setupApp(structuredClone(state));
    applicantSnapshotMocks.getEventApplicantSnapshot.mockResolvedValueOnce({ kind: 'expired' });
    const expired = await app.request('/api/events/admin/occurrences/s1/applicants.csv?account_id=la1&snapshot_id=old');
    expect(expired.status).toBe(410);
    applicantSnapshotMocks.getEventApplicantSnapshot.mockResolvedValueOnce({ kind: 'not_found' });
    const foreign = await app.request('/api/events/admin/occurrences/s1/applicants.csv?account_id=la1&snapshot_id=other-staff');
    expect(foreign.status).toBe(404);
    expect(waitlistMocks.getEventOccurrenceApplicants).not.toHaveBeenCalled();
  });

  test('not found / forbidden: 所属外を404、認証なしを403にする', async () => {
    waitlistMocks.getEventOccurrenceApplicants.mockResolvedValueOnce(null);
    const app = setupApp(structuredClone(state));
    const missing = await app.request('/api/events/admin/occurrences/other/applicants?account_id=la1');
    expect(missing.status).toBe(404);

    const unauthenticated = new Hono<TestEnv>();
    unauthenticated.route('/', events);
    const forbidden = await unauthenticated.request(
      '/api/events/admin/occurrences/s1/applicants',
      {},
      { DB: makeEventDb({ events: [] }) },
    );
    expect(forbidden.status).toBe(403);
  });

  test('conflict: expectedVersionと理由を必須にし、版違いを409で返す', async () => {
    const app = setupApp(structuredClone(state));
    const missingVersion = await app.request(
      '/api/events/admin/occurrences/s1/waitlist/promote?account_id=la1',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    );
    expect(missingVersion.status).toBe(422);

    // 手動の繰り上げは理由が必須。版より先に見る。
    const noReason = await app.request(
      '/api/events/admin/occurrences/s1/waitlist/promote?account_id=la1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 2 }),
      },
    );
    expect(noReason.status).toBe(422);
    await expect(noReason.json()).resolves.toMatchObject({ code: 'waitlist_reason_required' , fields: expect.any(Object), error: expect.any(String) });

    waitlistMocks.promoteEventWaitlist.mockResolvedValueOnce({ kind: 'conflict', currentVersion: 3 });
    const conflict = await app.request(
      '/api/events/admin/occurrences/s1/waitlist/promote?account_id=la1',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expectedVersion: 2, reason: '空きが出たため' }),
      },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: 'version_conflict', currentVersion: 3 });
  });
});

function baseEvent(over: Partial<EventRow>): EventRow {
  const now = new Date().toISOString();
  return {
    id: 'e1',
    line_account_id: 'la1',
    name: 'X',
    venue_name: null,
    venue_url: null,
    image_url: null,
    description: null,
    description_centered: 0,
    max_bookings_per_friend: null,
    requires_approval: 0,
    approval_deadline_hours: 24,
    cancel_deadline_hours_before: null,
    reminder_day_before_enabled: 1,
    reminder_hours_before: null,
    is_published: 0,
    folder_id: null,
    sort_order: 0,
    deleted_at: null,
    created_at: now,
    updated_at: now,
    version: 1,
    current_published_version_id: null,
    target_type: 'single',
    account_ids: null,
    dedup_priority: null,
    // 094。既定はいずれも「これまでと同じ」。
    visible_tag_id: null,
    waitlist_enabled: 0,
    entry_cutoff_hours_before: null,
    ...over,
  };
}

describe('094 公開対象・申込締切・キャンセル待ち', () => {
  const account = { id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' };
  const friend = { id: 'f1', line_account_id: 'la1', line_user_id: 'U1' };
  const futureSlot = {
    id: 's1',
    event_id: 'e1',
    starts_at: '2099-06-01T10:00:00Z',
    ends_at: '2099-06-01T12:00:00Z',
    capacity: 1,
    is_active: 1,
    sort_order: 0,
    deleted_at: null,
  };

  function book(
    app: ReturnType<typeof setupApp>,
    body: Record<string, unknown> = { slot_id: 's1' },
  ) {
    return app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'k1',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify(body),
    });
  }

  test('公開対象タグを持たない人は申し込めない', async () => {
    // 一覧や詳細でも隠すが、URL を直接叩けば素通りするので申込でも見る。
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, visible_tag_id: 't1' })],
      slots: [{ ...futureSlot, capacity: 5 }],
      bookings: [],
      accounts: [account],
      friends: [friend],
      friendTags: [],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(409);
    // 「タグが無い」ではなく「公開されていない」として返す。存在を伝えない。
    expect((await res.json()) as { error: string; code: string }).toEqual({ success: false, code: 'event_unpublished', error: 'event_unpublished' });
    expect(state.bookings).toHaveLength(0);
  });

  test('公開対象タグを持つ人は申し込める', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, visible_tag_id: 't1' })],
      slots: [{ ...futureSlot, capacity: 5 }],
      bookings: [],
      accounts: [account],
      friends: [friend],
      friendTags: [{ friend_id: 'f1', tag_id: 't1' }],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(201);
    expect(state.bookings).toHaveLength(1);
  });

  test('締め切りを過ぎていれば申し込めない', async () => {
    const soon = new Date(Date.now() + 30 * 60_000).toISOString(); // 30分後
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, entry_cutoff_hours_before: 1 })],
      slots: [{ ...futureSlot, starts_at: soon, capacity: 5 }],
      bookings: [],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(410);
    expect((await res.json()) as { error: string; code: string }).toEqual({ success: false, code: 'entry_closed', error: 'entry_closed' });
  });

  test('締め切りより前なら申し込める', async () => {
    const later = new Date(Date.now() + 5 * 3600_000).toISOString(); // 5時間後
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, entry_cutoff_hours_before: 1 })],
      slots: [{ ...futureSlot, starts_at: later, capacity: 5 }],
      bookings: [],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(201);
  });

  test('満席かつキャンセル待ちが無効なら、これまでどおり締め切る', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, waitlist_enabled: 0 })],
      slots: [futureSlot],
      bookings: [{ id: 'b0', event_id: 'e1', slot_id: 's1', status: 'confirmed' }],
      accounts: [account],
      friends: [friend],
      waitlist: [],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string; code: string }).toEqual({ success: false, code: 'slot_full', error: 'slot_full' });
    expect(state.waitlist).toHaveLength(0);
  });

  test('満席でキャンセル待ちが有効なら、待ちとして受ける', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, waitlist_enabled: 1 })],
      slots: [futureSlot],
      bookings: [{ id: 'b0', event_id: 'e1', slot_id: 's1', status: 'confirmed' }],
      accounts: [account],
      friends: [friend],
      waitlist: [],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    // 409 だと画面側は失敗として扱い、「待ちに入りました」を出せない。
    expect(res.status).toBe(200);
    expect((await res.json()) as { waitlisted: boolean }).toMatchObject({ waitlisted: true });
    expect(state.waitlist).toHaveLength(1);
    // 待ちは予約に入れない。定員の数え方に手を入れずに済ませるため。
    expect(state.bookings).toHaveLength(1);
  });

  test('複数人申込は人数分の席を使い、回答と初回判定を申込時点で固定する', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1 })],
      slots: [{ ...futureSlot, capacity: 3 }],
      bookings: [{
        id: 'past', event_id: 'e1', slot_id: 'past-slot', friend_id: 'f1',
        status: 'attended', requested_at: '2025-01-01T00:00:00.000Z', party_size: 1,
      } as BookingRow & Record<string, unknown>],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state), {
      slot_id: 's1', party_size: 2, answers: { companion: '母', pet: 'ポチ' },
    });
    expect(res.status).toBe(201);
    expect(state.bookings[1]).toMatchObject({
      party_size: 2,
      answer_snapshot_json: JSON.stringify({ companion: '母', pet: 'ポチ' }),
      first_participation: 0,
      first_participation_attended_count: 1,
    });
  });

  test('期限付き案内で保留した席には新しい申込を割り込ませない', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', is_published: 1, waitlist_enabled: 0 })],
      slots: [{ ...futureSlot, capacity: 2 }],
      bookings: [],
      waitlist: [{ slot_id: 's1', status: 'offered', party_size: 2 }],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const res = await book(setupApp(state));
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({ success: false, code: 'slot_full', error: 'slot_full' });
  });
});

describe('イベント申込のカスタム質問 (#841)', () => {
  const account = { id: 'la1', liff_id: 'L1', is_active: 1, channel_access_token: 'tok' };
  const friend = { id: 'f1', line_account_id: 'la1', line_user_id: 'U1' };
  const futureSlot = {
    id: 's1',
    event_id: 'e1',
    starts_at: '2099-06-01T10:00:00Z',
    ends_at: '2099-06-01T12:00:00Z',
    capacity: 5,
    is_active: 1,
    sort_order: 0,
    deleted_at: null,
  };
  function book(app: ReturnType<typeof setupApp>, body: Record<string, unknown>) {
    return app.request('/api/liff/events/e1/bookings?liffId=L1', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'k1',
        Authorization: 'Bearer t',
      },
      body: JSON.stringify(body),
    });
  }

  test('作成時に質問を保存し、id未指定には連番を補う', async () => {
    const state = { events: [] as EventRow[] };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events?account_id=la1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        questions: [
          { label: 'アレルギーはありますか', type: 'text', required: true },
          { id: 'kind', label: '参加区分', type: 'radio', required: false, options: ['会場', 'オンライン'] },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const stored = JSON.parse(state.events[0].questions_json as string) as Array<Record<string, unknown>>;
    expect(stored).toEqual([
      { id: 'q1', label: 'アレルギーはありますか', type: 'text', required: true, options: null },
      { id: 'kind', label: '参加区分', type: 'radio', required: false, options: ['会場', 'オンライン'] },
    ]);
  });

  test('不正な質問定義は 422 invalid_questions', async () => {
    for (const questions of [
      'not-an-array',
      [{ label: '', type: 'text' }],
      [{ label: 'X', type: 'date' }],
      [{ label: 'X', type: 'radio' }],
      [{ label: 'X', type: 'radio', options: [] }],
      Array.from({ length: 11 }, (_, i) => ({ label: `Q${i}`, type: 'text' })),
      [{ id: 'same', label: 'A', type: 'text' }, { id: 'same', label: 'B', type: 'text' }],
    ]) {
      const app = setupApp({ events: [] });
      const res = await app.request('/api/events/admin/events?account_id=la1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'X', questions }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()) as { error: string; code: string }).toMatchObject({ code: 'invalid_questions' , fields: expect.any(Object), error: expect.any(String) });
    }
  });

  test('更新で質問を差し替えられる', async () => {
    const state = {
      events: [baseEvent({ id: 'e1', questions_json: null })],
    };
    const app = setupApp(state);
    const res = await app.request('/api/events/admin/events/e1?account_id=la1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        expected_version: 1,
        questions: [{ label: '同伴者', type: 'checkbox', required: false, options: ['犬', '猫'] }],
      }),
    });
    expect(res.status).toBe(200);
    const saved = JSON.parse(state.events[0].questions_json as string) as Array<Record<string, unknown>>;
    expect(saved[0]).toMatchObject({ label: '同伴者', type: 'checkbox', options: ['犬', '猫'] });
  });

  test('LIFF詳細は質問を配列で返す', async () => {
    const state = {
      events: [baseEvent({
        id: 'e1',
        is_published: 1,
        questions_json: JSON.stringify([{ id: 'q1', label: '人数', type: 'text', required: true, options: null }]),
      })],
      accounts: [account],
    };
    const app = setupApp(state);
    const res = await app.request('/api/liff/events/e1?liffId=L1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { questions: unknown[] };
    expect(body.questions).toEqual([
      { id: 'q1', label: '人数', type: 'text', required: true, options: null },
    ]);
  });

  test('必須質問への回答が無い申込は 422 missing_required_answers', async () => {
    const state = {
      events: [baseEvent({
        id: 'e1',
        is_published: 1,
        questions_json: JSON.stringify([
          { id: 'q1', label: 'アレルギー', type: 'text', required: true, options: null },
          { id: 'q2', label: '希望', type: 'checkbox', required: false, options: ['A', 'B'] },
        ]),
      })],
      slots: [futureSlot],
      bookings: [],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await book(app, { slot_id: 's1', answers: { q2: ['A'] } });
    expect(res.status).toBe(422);
    expect((await res.json()) as { error: string; code: string }).toEqual({ success: false, code: 'missing_required_answers', error: 'missing_required_answers', fields: {} });
    expect(state.bookings).toHaveLength(0);
  });

  test('回答は質問idをキーに保存される', async () => {
    const state = {
      events: [baseEvent({
        id: 'e1',
        is_published: 1,
        questions_json: JSON.stringify([
          { id: 'q1', label: 'アレルギー', type: 'text', required: true, options: null },
          { id: 'q2', label: '希望', type: 'checkbox', required: false, options: ['A', 'B'] },
        ]),
      })],
      slots: [futureSlot],
      bookings: [] as BookingRow[],
      accounts: [account],
      friends: [friend],
    };
    liffAuthMocks.verifyCallerLineUserId.mockResolvedValue('U1');
    idempotencyMocks.reserveEventIdempotency.mockResolvedValue({ kind: 'inserted' });
    const app = setupApp(state);
    const res = await book(app, {
      slot_id: 's1',
      answers: { q1: 'なし', q2: ['A', 'B'] },
    });
    expect(res.status).toBe(201);
    expect(state.bookings[0].answer_snapshot_json).toBe(
      JSON.stringify({ q1: 'なし', q2: ['A', 'B'] }),
    );
  });
});
