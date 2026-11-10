import { jstNow } from '../utils.js';

/**
 * 予約の支払い設定と記録。
 *
 * 決済サービスごとの鍵はここに置かない（Worker の秘密値から読む）。
 * ここが持つのは「どの店・どのメニューがどう払うか」と「払った記録」だけ。
 */

export type BookingPaymentMode = 'none' | 'onsite' | 'online' | 'customer_choice';
export type BookingPaymentProviderName = 'none' | 'onsite' | 'stripe';
export type BookingPaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'paid'
  | 'failed'
  | 'refunded'
  | 'expired';

export interface BookingPaymentConfig {
  mode: BookingPaymentMode;
  /** 差し替えのために名前は絞らない。未登録の名前は呼び出し側で止める。 */
  provider: string;
  holdMinutes: number;
}

const DEFAULT_CONFIG: BookingPaymentConfig = { mode: 'none', provider: 'none', holdMinutes: 10 };

function normalizeMode(value: unknown): BookingPaymentMode | null {
  return value === 'none' || value === 'onsite' || value === 'online' || value === 'customer_choice' ? value : null;
}

function normalizeProvider(value: unknown, fallback = 'none'): string {
  if (typeof value === 'string' && value.trim() && value.length <= 64) return value.trim();
  return fallback;
}

/** 店の既定。行がなければ「お支払いなし」。 */
export async function getBookingPaymentConfig(
  db: D1Database,
  lineAccountId: string,
): Promise<BookingPaymentConfig> {
  const row = await db.prepare(
    `SELECT mode, provider, hold_minutes FROM booking_payment_configs WHERE line_account_id = ?`,
  ).bind(lineAccountId).first<{ mode: string; provider: string; hold_minutes: number }>();
  if (!row) return { ...DEFAULT_CONFIG };
  return {
    mode: normalizeMode(row.mode) ?? 'none',
    provider: normalizeProvider(row.provider, 'none'),
    holdMinutes: Number.isFinite(Number(row.hold_minutes))
      ? Math.min(1440, Math.max(5, Math.trunc(Number(row.hold_minutes))))
      : DEFAULT_CONFIG.holdMinutes,
  };
}

export async function saveBookingPaymentConfig(
  db: D1Database,
  lineAccountId: string,
  input: BookingPaymentConfig,
): Promise<BookingPaymentConfig> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO booking_payment_configs (line_account_id, mode, provider, hold_minutes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(line_account_id) DO UPDATE SET
       mode = excluded.mode, provider = excluded.provider,
       hold_minutes = excluded.hold_minutes, updated_at = excluded.updated_at`,
  ).bind(lineAccountId, input.mode, input.provider, input.holdMinutes, now, now).run();
  return { ...input };
}

/**
 * メニューごとの上書き込みで決める。行がなければ店の既定。
 * online なのにプロバイダが none のような壊れた組み合わせは
 * 店頭扱いに倒さず、そのまま返して呼び出し側で止める。
 */
export async function resolveBookingPaymentConfig(
  db: D1Database,
  lineAccountId: string,
  menuId: string,
): Promise<BookingPaymentConfig> {
  const row = await db.prepare(
    `SELECT mode, provider FROM booking_payment_menu_settings
      WHERE menu_id = ? AND line_account_id = ?`,
  ).bind(menuId, lineAccountId).first<{ mode: string; provider: string }>();
  if (!row) return getBookingPaymentConfig(db, lineAccountId);
  const store = await getBookingPaymentConfig(db, lineAccountId);
  return {
    mode: normalizeMode(row.mode) ?? store.mode,
    provider: normalizeProvider(row.provider, store.provider),
    holdMinutes: store.holdMinutes,
  };
}

export async function saveBookingPaymentMenuSetting(
  db: D1Database,
  lineAccountId: string,
  menuId: string,
  input: { mode: BookingPaymentMode; provider: BookingPaymentProviderName },
): Promise<void> {
  const now = jstNow();
  await db.prepare(
    `INSERT INTO booking_payment_menu_settings
       (menu_id, line_account_id, mode, provider, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(menu_id) DO UPDATE SET
       mode = excluded.mode, provider = excluded.provider, updated_at = excluded.updated_at`,
  ).bind(menuId, lineAccountId, input.mode, input.provider, now, now).run();
}

export interface BookingPaymentRecord {
  id: string;
  line_account_id: string;
  booking_id: string | null;
  amount: number;
  currency: string;
  status: BookingPaymentStatus;
  provider: string;
  provider_payment_id: string | null;
  idempotency_key: string;
  hold_until: string | null;
  paid_at: string | null;
  refunded_amount?: number;
  actor_label?: string | null;
  action_reason?: string | null;
  refunded_at?: string | null;
  receipt_url?: string | null;
}

/** 予約保存のbatch用。枠の競合で予約が作られなければ支払い行も作らない。 */
export function bookingPaymentInsertStatement(db: D1Database, input: {
  id: string; lineAccountId: string; bookingId: string; amount: number;
  provider: string; holdUntil: string; now: string;
}): D1PreparedStatement {
  return db.prepare(`INSERT INTO booking_payments
    (id,line_account_id,booking_id,amount,currency,status,provider,idempotency_key,hold_until,created_at,updated_at)
    SELECT ?,?,?,?,'JPY','unpaid',?,?,?,?,? WHERE EXISTS (
      SELECT 1 FROM bookings WHERE id = ? AND line_account_id = ?)`)
    .bind(input.id, input.lineAccountId, input.bookingId, Math.max(0, Math.trunc(input.amount)),
      input.provider, `booking:${input.bookingId}`, input.holdUntil, input.now, input.now,
      input.bookingId, input.lineAccountId);
}

export async function createBookingPayment(
  db: D1Database,
  input: {
    lineAccountId: string;
    bookingId: string;
    amount: number;
    currency?: string;
    provider: string;
    idempotencyKey: string;
    holdUntil?: string | null;
  },
): Promise<BookingPaymentRecord> {
  const now = jstNow();
  const id = crypto.randomUUID();
  await db.prepare(
    `INSERT OR IGNORE INTO booking_payments
       (id, line_account_id, booking_id, amount, currency, status,
        provider, provider_payment_id, idempotency_key, hold_until, paid_at,
        created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, 'unpaid', ?, NULL, ?, ?, NULL, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM booking_payments WHERE line_account_id=? AND booking_id=?)`,
  ).bind(
    id, input.lineAccountId, input.bookingId, Math.max(0, Math.trunc(input.amount)),
    input.currency ?? 'JPY', input.provider, input.idempotencyKey,
    input.holdUntil ?? null, now, now, input.lineAccountId, input.bookingId,
  ).run();
  const saved = await db.prepare(
    `SELECT * FROM booking_payments WHERE line_account_id = ? AND (idempotency_key = ? OR booking_id = ?)
      ORDER BY CASE WHEN idempotency_key = ? THEN 0 ELSE 1 END,created_at DESC,id LIMIT 1`,
  ).bind(input.lineAccountId, input.idempotencyKey, input.bookingId, input.idempotencyKey).first<BookingPaymentRecord>();
  if (!saved) throw new Error('booking payment could not be created');
  return saved;
}

export async function getBookingPaymentByBooking(
  db: D1Database,
  lineAccountId: string,
  bookingId: string,
): Promise<BookingPaymentRecord | null> {
  return await db.prepare(
    `SELECT * FROM booking_payments WHERE line_account_id = ? AND booking_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(lineAccountId, bookingId).first<BookingPaymentRecord>();
}

export async function markBookingPayment(
  db: D1Database,
  input: {
    lineAccountId: string;
    paymentId: string;
    status: BookingPaymentStatus;
    providerPaymentId?: string | null;
  },
): Promise<BookingPaymentRecord | null> {
  const now = jstNow();
  await db.prepare(
    `UPDATE booking_payments
        SET confirmation_revision=confirmation_revision+1, status = ?, provider_payment_id = COALESCE(?, provider_payment_id),
            paid_at = CASE WHEN ? = 'paid' THEN COALESCE(paid_at, ?) ELSE paid_at END,
            refunded_at = CASE WHEN ? = 'refunded' THEN COALESCE(refunded_at, ?) ELSE refunded_at END,
            updated_at = ?
      WHERE id = ? AND line_account_id = ?`,
  ).bind(
    input.status, input.providerPaymentId ?? null, input.status, now, input.status, now, now,
    input.paymentId, input.lineAccountId,
  ).run();
  return await db.prepare(
    `SELECT * FROM booking_payments WHERE id = ? AND line_account_id = ?`,
  ).bind(input.paymentId, input.lineAccountId).first<BookingPaymentRecord>();
}

/** 予約時の本人の選択を優先し、既存予約は店/メニューの設定を読む。 */
export async function resolveBookingPaymentForBooking(db: D1Database, accountId: string, bookingId: string, menuId: string): Promise<BookingPaymentConfig> {
  const entitlement=await db.prepare('SELECT u.booking_id FROM booking_entitlement_uses u JOIN bookings b ON b.id=u.booking_id WHERE b.id=? AND b.line_account_id=?').bind(bookingId,accountId).first();
  if(entitlement)return {mode:'none',provider:'none',holdMinutes:10};
  const choice = await db.prepare(`SELECT mode,provider,hold_minutes FROM booking_payment_choices WHERE booking_id=? AND line_account_id=?`)
    .bind(bookingId,accountId).first<{mode:'onsite'|'online';provider:string;hold_minutes:number}>();
  if (choice) return {mode:choice.mode,provider:choice.provider,holdMinutes:choice.hold_minutes};
  return resolveBookingPaymentConfig(db,accountId,menuId);
}
