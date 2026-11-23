import {calendarCredentialsForEnv} from '../features/booking/booking-outlook-busy-runtime/index.js';
import {syncOutlookBookingForEnv} from '../features/booking/booking-outlook-sync-runtime/index.js';
import { meetingCreatorForBooking } from '../features/booking/booking-meeting-runtime/index.js';
import { readBodyWithinLimit } from '../services/stripe-signature.js';
import { externalBookingStripeObject } from '../features/booking/booking-stripe-webhooks/index.js';
import { liffBookingJson, liffBookingInputError } from './liff-booking-response.js';
import { logger } from '@line-crm/shared/server';
import { runBookingPaymentStart } from '../features/booking/booking-payment-start/index.js';
import { safeReceiptUrl } from '../features/booking/booking-payment-history/index.js';
import { expireBookingPaymentIfHeld } from './booking-payment-expiration.js';
export { expireBookingPaymentIfHeld } from './booking-payment-expiration.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { Hono } from 'hono';
import {
  getWorkflowStep,
  createBookingPayment,
  getBookingPaymentByBooking,
  getBookingPaymentConfig,
  resolveBookingPaymentConfig,
  resolveBookingPaymentForBooking,
  saveBookingPaymentConfig,
  saveBookingPaymentMenuSetting,
  type BookingPaymentRecord,
  type BookingPaymentMode,
  type BookingPaymentProviderName,
} from '@line-crm/db';

import type { Env } from '../worker-env.js';
import { PaymentActionError, linkPaymentBooking, parseRefundInput, refundHistory, simulatePaymentRefund } from '../features/booking/booking-payment-refunds/index.js';
import { requireRole, denyReadOnly } from '../middleware/role-guard.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import {
  resolveAccountIdFromLiff,
  resolveFriendId,
  verifyCallerLineUserId,
} from './booking.js';
import {
  createStripeTestProvider,
  getPaymentProvider,
  registerPaymentProvider,
  type PaymentProvider,
} from '../services/payment-providers.js';
import { reconcileExpiredBookingPayment, reconcilePaidBookingPayment } from '../features/booking/booking-payment-recovery/index.js';
import { receivePaymentEvent } from '../features/booking/booking-payment-events/index.js';

/**
 * 予約の支払い（決済サービスを差し替えられる作り）。
 *
 * 既存の Stripe まわり（hq-billing など）は触らない。予約の支払いは
 * 別の口として作る。鍵の値はコード・試験・DBに書かず、秘密値から読む。
 * 設定画面には「鍵が入っているか」だけ出す。
 */

const bookingPayments = new Hono<Env>();

function providerFor(
  env: Env['Bindings'],
  name: string,
): PaymentProvider | null {
  if (name === 'stripe') {
    return createStripeTestProvider({ webhookSecret: env.STRIPE_TEST_WEBHOOK_SECRET ?? '' });
  }
  return getPaymentProvider(name);
}

/** テスト用の差し替え口。予約の流れは触らず、登録表だけ差す。 */
export function registerTestPaymentProvider(provider: PaymentProvider): void {
  registerPaymentProvider(provider);
}

function validMode(value: unknown): BookingPaymentMode | null {
  return value === 'none' || value === 'onsite' || value === 'online' || value === 'customer_choice' ? value : null;
}

function validProvider(value: unknown): BookingPaymentProviderName | null {
  return value === 'none' || value === 'onsite' || value === 'stripe' ? value : null;
}

// GET /api/booking/admin/payment-config — 店の既定と鍵の有無
bookingPayments.get(
  '/api/booking/admin/payment-config',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const accountId = c.req.query('account_id')?.trim();
    if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    const config = await getBookingPaymentConfig(c.env.DB, accountId);
    return c.json({
      success: true,
      data: {
        ...config,
        keyConfigured: config.provider === 'stripe'
          ? Boolean(c.env.STRIPE_TEST_WEBHOOK_SECRET)
          : true,
        testMode: config.provider === 'stripe',
      },
    });
  },
);

// PUT /api/booking/admin/payment-config — 店の既定を変える
bookingPayments.put(
  '/api/booking/admin/payment-config',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const accountId = c.req.query('account_id')?.trim();
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["account_id"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    const body = await c.req.json<{
      mode?: unknown; provider?: unknown; holdMinutes?: unknown;
    }>().catch(() => null);
    const mode = validMode(body?.mode);
    const provider = validProvider(body?.provider);
    const holdMinutes = Number(body?.holdMinutes);
    if (!mode || !provider) {
      return inputError(c, { success: false, error: 'mode と provider を指定してください' }, 400, ["mode","provider"]);
    }
    if (!Number.isInteger(holdMinutes) || holdMinutes < 5 || holdMinutes > 1440) {
      return inputError(c, { success: false, error: 'holdMinutes は 5〜1440 の整数で指定してください' }, 400, ["holdMinutes"]);
    }
    if ((mode === 'online' || mode === 'customer_choice') && provider !== 'stripe') {
      return inputError(c, { success: false, error: 'online の provider は stripe を指定してください' }, 400, ["mode","provider"]);
    }
    if (mode !== 'online' && mode !== 'customer_choice' && provider === 'stripe') {
      return inputError(c, { success: false, error: 'stripe を使うときは mode を online にしてください' }, 400, ["mode","provider"]);
    }
    const saved = await saveBookingPaymentConfig(c.env.DB, accountId, { mode, provider, holdMinutes });
    return c.json({ success: true, data: saved });
  },
);

// PUT /api/booking/admin/menus/:id/payment — メニューごとの上書き
bookingPayments.put(
  '/api/booking/admin/menus/:id/payment',
  requireRole('owner', 'admin'),
  inputJsonBoundary(), async (c) => {
    const accountId = c.req.query('account_id')?.trim();
    if (!accountId) return inputError(c, { success: false, error: 'account_id が必要です' }, 400, ["account_id"]);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    const menuId = c.req.param('id');
    const menu = await c.env.DB.prepare(
      `SELECT id FROM menus WHERE id = ? AND line_account_id = ? AND deleted_at IS NULL`,
    ).bind(menuId, accountId).first<{ id: string }>();
    if (!menu) return c.json({ success: false, error: '対象が見つかりません' }, 404);
    const body = await c.req.json<{ mode?: unknown; provider?: unknown }>().catch(() => null);
    const mode = validMode(body?.mode);
    const provider = validProvider(body?.provider);
    if (!mode || !provider) {
      return inputError(c, { success: false, error: 'mode と provider を指定してください' }, 400, ["mode","provider"]);
    }
    if (((mode === 'online' || mode === 'customer_choice') && provider !== 'stripe')
      || (mode !== 'online' && mode !== 'customer_choice' && provider === 'stripe')) {
      return inputError(c, {success:false,error:'invalid_payment_provider'},400,['mode','provider']);
    }
    await saveBookingPaymentMenuSetting(c.env.DB, accountId, menuId, { mode, provider });
    const effective = await resolveBookingPaymentConfig(c.env.DB, accountId, menuId);
    return c.json({ success: true, data: effective });
  },
);

interface StartBookingRow {
  id: string;
  line_account_id: string;
  price_at_booking: number;
  status: string;
}

/**
 * 支払いを始める中身。担当者用とお客さま用で共用する。
 * 同じ予約の送り直しは作り直さず、今の記録を返す。
 */
export async function startBookingPayment(
  db: D1Database,
  env: Env['Bindings'],
  booking: StartBookingRow,
  idempotencyKey: string,
): Promise<
  | { ok: true; created: boolean; paymentId: string; checkoutUrl: string | null }
  | { ok: false; error: string; status: 409 }
> {
  if (booking.status !== 'requested') {
    return { ok: false, error: 'この予約は支払いの対象ではありません', status: 409 };
  }
  const bookingMenu = await db.prepare(
    `SELECT menu_id FROM bookings WHERE id = ?`,
  ).bind(booking.id).first<{ menu_id: string }>();
  const config = await resolveBookingPaymentForBooking(
    db, booking.line_account_id, booking.id, bookingMenu?.menu_id ?? '',
  );
  if (config.mode !== 'online') {
    return { ok: false, error: 'この予約はオンライン支払いの対象ではありません', status: 409 };
  }
  if (!providerFor(env, config.provider)) {
    return { ok: false, error: '支払いの準備ができていません', status: 409 };
  }
  const holdUntil = new Date(Date.now() + config.holdMinutes * 60_000).toISOString();
  const record = await createBookingPayment(db, {
    lineAccountId: booking.line_account_id,
    bookingId: booking.id,
    amount: Number(booking.price_at_booking ?? 0),
    provider: config.provider,
    idempotencyKey,
    holdUntil,
  });
  if (record.booking_id !== booking.id) {
    return { ok: false, error: 'この支払いの記録は別の予約に使われています', status: 409 };
  }
  if (record.status === 'pending') {
    const provider = providerFor(env, record.provider);
    const checkoutUrl = record.provider_payment_id && provider?.getCheckoutUrl
      ? await provider.getCheckoutUrl({
        providerPaymentId: record.provider_payment_id,
        idempotencyKey: record.idempotency_key,
      })
      : null;
    if (!checkoutUrl) {
      return { ok: false, error: '元の支払い画面を取得できません。担当者にお問い合わせください', status: 409 };
    }
    return { ok: true, created: false, paymentId: record.id, checkoutUrl };
  }
  if (record.status !== 'unpaid') {
    return { ok: true, created: false, paymentId: record.id, checkoutUrl: null };
  }
  if(record.hold_until&&Date.parse(record.hold_until)<=Date.now())return {ok:false,error:'支払い期限が過ぎています。担当者にお問い合わせください',status:409};
  const outcome = await runBookingPaymentStart(db, record, providerFor(env, record.provider)!);
  if (outcome.kind !== 'success') {
    return { ok: false, error: outcome.kind === 'unknown'
      ? '支払いの結果を確認しています。開始し直さず担当者にお問い合わせください'
      : '支払いを開始できません。担当者にお問い合わせください', status: 409 };
  }
  return { ok: true, created: true, paymentId: record.id, checkoutUrl: outcome.value.checkoutUrl };
}

async function bookingPaymentStatusPayload(
  db: D1Database,
  lineAccountId: string,
  bookingId: string,
  env: Env['Bindings'],
) {
  const record = await expireBookingPaymentIfHeld(db, lineAccountId, bookingId, id=>meetingCreatorForBooking(env,id),id=>syncOutlookBookingForEnv(env,id),calendarCredentialsForEnv(env));
  const checkpoint=await getWorkflowStep(db,{scopeId:`line:${lineAccountId}`,processKind:'booking_payment_start',subjectId:bookingId,stepKey:'start'});
  return { payment: customerPaymentRecord(record),...(checkpoint?.status==='unknown'?{operation_status:'unknown',action_required:true}:{}) };
}

function customerPaymentRecord(record: BookingPaymentRecord | null) {
  return record ? {id:record.id,status:record.status,amount:record.amount,currency:record.currency,
    hold_until:record.hold_until,refunded_amount:record.refunded_amount ?? 0,receipt_url:safeReceiptUrl(record.receipt_url)} : null;
}

// POST /api/booking/payments/start — 支払いを始める（担当者用）
bookingPayments.post(
  '/api/booking/payments/start',
  requireRole('owner', 'admin', 'staff'),
  inputJsonBoundary(), async (c) => {
    const body = await c.req.json<{ bookingId?: unknown; idempotencyKey?: unknown }>().catch(() => null);
    const bookingId = String(body?.bookingId ?? '');
    if (!bookingId) return inputError(c, { success: false, error: 'bookingId が必要です' }, 400, ["bookingId"]);
    const booking = await c.env.DB.prepare(
      `SELECT id, line_account_id, price_at_booking, status FROM bookings WHERE id = ?`,
    ).bind(bookingId).first<StartBookingRow>();
    if (!booking
      || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [booking.line_account_id])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    const idempotencyKey = typeof body?.idempotencyKey === 'string' && body.idempotencyKey
      ? body.idempotencyKey.slice(0, 200)
      : `booking:${bookingId}`;
    const result = await startBookingPayment(c.env.DB, c.env, booking, idempotencyKey);
    if (!result.ok) return inputError(c, { success: false, error: result.error }, result.status, []);
    const current = await getBookingPaymentByBooking(c.env.DB, booking.line_account_id, bookingId);
    return c.json(
      { success: true, data: { payment: current, checkoutUrl: result.checkoutUrl } },
      result.created ? 201 : 200,
    );
  },
);

// POST /api/liff/booking/payments/start — 支払いを始める（お客さま用）
bookingPayments.post('/api/liff/booking/payments/start', inputJsonBoundary(), async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  const callerLineUserId = await verifyCallerLineUserId(c);
  if (!callerLineUserId) return liffBookingJson(c, { error: 'unauthorized' }, 401);
  const friendId = await resolveFriendId(c, callerLineUserId, accountId);
  if (!friendId) return liffBookingJson(c, { error: 'friend_not_found' }, 404);
  const body = await c.req.json<{ bookingId?: unknown }>().catch(() => null);
  const bookingId = String(body?.bookingId ?? '');
  if (!bookingId) return liffBookingInputError(c, { error: 'bookingId が必要です' }, 400, ["bookingId"]);
  const booking = await c.env.DB.prepare(
    `SELECT id, line_account_id, price_at_booking, status FROM bookings WHERE id = ? AND friend_id = ?`,
  ).bind(bookingId, friendId).first<StartBookingRow>();
  if (!booking || booking.line_account_id !== accountId) {
    return liffBookingJson(c, { error: '対象が見つかりません' }, 404);
  }
  const result = await startBookingPayment(c.env.DB, c.env, booking, `booking:${bookingId}`);
  if (!result.ok) return liffBookingInputError(c, { error: result.error }, result.status, []);
  const current = await getBookingPaymentByBooking(c.env.DB, accountId, bookingId);
  return liffBookingJson(c,
    { payment: customerPaymentRecord(current), checkoutUrl: result.checkoutUrl },
    result.created ? 201 : 200,
  );
});

// GET /api/liff/booking/payments/by-booking — 支払いの状態（お客さま用）
bookingPayments.get('/api/liff/booking/payments/by-booking', async (c) => {
  const accountId = await resolveAccountIdFromLiff(c);
  if (!accountId) return liffBookingJson(c, { error: 'unknown_liff' }, 404);
  const callerLineUserId = await verifyCallerLineUserId(c);
  if (!callerLineUserId) return liffBookingJson(c, { error: 'unauthorized' }, 401);
  const friendId = await resolveFriendId(c, callerLineUserId, accountId);
  if (!friendId) return liffBookingJson(c, { error: 'friend_not_found' }, 404);
  const bookingId = c.req.query('bookingId')?.trim();
  if (!bookingId) return liffBookingJson(c, { error: 'bookingId が必要です' }, 400);
  const booking = await c.env.DB.prepare(
    `SELECT id FROM bookings WHERE id = ? AND friend_id = ? AND line_account_id = ?`,
  ).bind(bookingId, friendId, accountId).first<{ id: string }>();
  if (!booking) return liffBookingJson(c, { error: '対象が見つかりません' }, 404);
  return liffBookingJson(c, await bookingPaymentStatusPayload(c.env.DB, accountId, bookingId, c.env));
});

// GET /api/booking/payments/by-booking — 支払いの状態（仮押さえの期限切れもここで落とす）
bookingPayments.get(
  '/api/booking/payments/by-booking',
  requireRole('owner', 'admin', 'staff'),
  async (c) => {
    const bookingId = c.req.query('bookingId')?.trim();
    if (!bookingId) return c.json({ success: false, error: 'bookingId が必要です' }, 400);
    const booking = await c.env.DB.prepare(
      `SELECT id, line_account_id FROM bookings WHERE id = ?`,
    ).bind(bookingId).first<{ id: string; line_account_id: string }>();
    if (!booking
      || !await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [booking.line_account_id])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    const record = await expireBookingPaymentIfHeld(
      c.env.DB, booking.line_account_id, bookingId, id=>meetingCreatorForBooking(c.env,id), id=>syncOutlookBookingForEnv(c.env,id), calendarCredentialsForEnv(c.env),
    );
    return c.json({ success: true, data: { payment: record } });
  },
);

// 支払いを扱う操作は所属と閲覧のみを個別にも確認する。
async function accessiblePayment(c: import('hono').Context<Env>) {
  const record = await c.env.DB.prepare('SELECT * FROM booking_payments WHERE id=?')
    .bind(c.req.param('id')).first<BookingPaymentRecord>();
  return record && await canAccessAllLineAccounts(c.env.DB,c.get('staff'),[record.line_account_id]) ? record : null;
}
bookingPayments.onError((error,c) => {
  if (error instanceof PaymentActionError) return (c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {success:false,error:error.code,code:error.code}, error.status) : c.json({success:false,error:error.code,code:error.code},error.status));
  const missing = /no such (table|column).*?(booking_payment_refunds|booking_payment_booking_links|refunded_amount|actor_label)/.test(String(error));
  if (!missing) throw error;
  const code = 'payment_refund_storage_not_ready';
  logger.error(code);
  return (c.req.path.startsWith('/api/liff/') ? liffBookingJson(c, {success:false,error:code,code}, /\/(refund|refunds|booking)$/.test(c.req.path) ? 503 : 500) : c.json({success:false,error:code,code}, /\/(refund|refunds|booking)$/.test(c.req.path) ? 503 : 500));
});
bookingPayments.post('/api/booking/payments/:id/refund',requireRole('owner','admin'),denyReadOnly(),inputJsonBoundary(),async c => {
  c.header('Cache-Control','no-store');
  const payment = await accessiblePayment(c);
  if (!payment) return c.json({success:false,error:'not_found'},404);
  const input = parseRefundInput(await c.req.json().catch(()=>null));
  if (!input) return inputError(c,{success:false,error:'invalid_refund'},400,['amount','reason','notifyLine','idempotencyKey']);
  return c.json({success:true,data:await simulatePaymentRefund(c.env.DB,payment,input,c.get('staff'))});
});
bookingPayments.get('/api/booking/payments/:id/refunds',requireRole('owner','admin','staff'),async c => {
  c.header('Cache-Control','no-store');
  const payment = await accessiblePayment(c);
  if (!payment) return c.json({success:false,error:'not_found'},404);
  return c.json({success:true,data:{items:await refundHistory(c.env.DB,payment.line_account_id,payment.id)}});
});
bookingPayments.post('/api/booking/payments/:id/booking',requireRole('owner','admin'),denyReadOnly(),inputJsonBoundary(),async c => {
  c.header('Cache-Control','no-store');
  const payment = await accessiblePayment(c);
  if (!payment) return c.json({success:false,error:'not_found'},404);
  const body = await c.req.json<{bookingId?:unknown;reason?:unknown}>().catch(()=>null);
  if (typeof body?.bookingId!=='string' || !body.bookingId || body.bookingId.length>200
    || typeof body?.reason!=='string' || !body.reason.trim() || body.reason.trim().length>500) {
    return inputError(c,{success:false,error:'invalid_payment_link'},400,['bookingId','reason']);
  }
  return c.json({success:true,data:await linkPaymentBooking(c.env.DB,payment,body.bookingId,body.reason.trim(),c.get('staff'))});
});

// POST /api/booking/payments/webhook/:provider — 支払い済みの知らせ
bookingPayments.post(
  '/api/booking/payments/webhook/:provider',
  async (c) => {
    const providerName = c.req.param('provider');
    const rawBody = await readBodyWithinLimit(c.req.raw);
    if (rawBody === null) {
      return c.json({ success: false, error: 'Payload too large' }, 413);
    }
    const signature = c.req.header('stripe-signature') ?? c.req.header('x-payment-signature') ?? '';
    const provider = providerFor(c.env, providerName);
    if (!provider) return c.json({ success: false, error: 'unknown provider' }, 404);
    const outcome = await provider.verifyWebhook(rawBody, signature);
    if (!outcome) return c.json({ success: false, error: 'Invalid signature' }, 401);
    if (providerName === 'stripe' && await externalBookingStripeObject(c.env.DB,outcome.providerPaymentId)) return c.json({success:false,error:'connect_webhook_required'},409);
    const result = await receivePaymentEvent(c.env.DB, providerName, outcome, rawBody);
    if (['event_conflict','busy_or_missing'].includes(result.status) || result.result==='failed') {
      return c.json({success:false,error:'payment_event_unavailable',code:'payment_event_unavailable'},503);
    }
    if (outcome.status==='paid' && ['paid','duplicate'].includes(result.status)) {
      const payment=await c.env.DB.prepare('SELECT id FROM booking_payments WHERE provider=? AND provider_payment_id=?')
        .bind(providerName,outcome.providerPaymentId).first<{id:string}>();
      if (payment) await reconcilePaidBookingPayment(c.env.DB,payment.id,new Date(),false,calendarCredentialsForEnv(c.env), id=>meetingCreatorForBooking(c.env,id), id=>syncOutlookBookingForEnv(c.env,id));
    }
    return c.json({ success: true, status: result.status });
  },
);

/**
 * 支払い済みを予約へ反映する。二重の知らせは2回目を受け付け済みで返す。
 * 店のルールと両立：manual なら「支払い済み・承認待ち」（requested のまま）、
 * automatic なら確定（confirmed）にする。
 */
export async function applyPaidBookingPayment(
  db: D1Database,
  providerPaymentId: string,
  credentials: import('../services/google-service-account.js').GoogleServiceAccountCredentials = {},
): Promise<{ duplicate: boolean } | null> {
  const row = await db.prepare(
    `SELECT id FROM booking_payments WHERE provider_payment_id = ?`,
  ).bind(providerPaymentId).first<{ id: string }>();
  return row ? reconcilePaidBookingPayment(db, row.id, new Date(), true, credentials) : null;
}

// DELETE /api/booking/admin/menus/:id/payment — メニューごとの上書きを消して店の既定に戻す
bookingPayments.delete(
  '/api/booking/admin/menus/:id/payment',
  requireRole('owner', 'admin'),
  async (c) => {
    const accountId = c.req.query('account_id')?.trim();
    if (!accountId) return c.json({ success: false, error: 'account_id が必要です' }, 400);
    if (!await canAccessAllLineAccounts(c.env.DB, c.get('staff'), [accountId])) {
      return c.json({ success: false, error: '対象が見つかりません' }, 404);
    }
    await c.env.DB.prepare(
      `DELETE FROM booking_payment_menu_settings WHERE menu_id = ? AND line_account_id = ?`,
    ).bind(c.req.param('id'), accountId).run();
    return c.json({ success: true, data: { cleared: true } });
  },
);

export { bookingPayments };
