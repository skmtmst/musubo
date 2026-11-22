import { listStripeReviews } from '../features/booking/booking-stripe-review.js';
import { logger } from '@line-crm/shared/server';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Env } from '../worker-env.js';
import { canAccessAllLineAccounts } from '../services/account-access.js';
import { inputError, inputJsonBoundary } from '../lib/input-errors.js';
import { paymentCsv, paymentRecordFilter, paymentRecords, paymentSummary, staffTodayCounts } from '../features/booking/booking-payment-admin/index.js';
import { startBookingPayment } from './booking-payments.js';
import { paymentSettingResponse } from './booking-payment-settings.js';
import { paymentEvent, paymentEventFilter, paymentEventList, processPaymentEvent } from '../features/booking/booking-payment-events/index.js';
import { registerStripeConnectRoutes } from './booking-stripe-connect.js';

export const bookingPaymentAdmin = new Hono<Env>();
bookingPaymentAdmin.onError((error,c)=>{
  const missing=/no such table: (booking_payment_choices|booking_payments|booking_payment_configs|booking_payment_menu_settings|booking_payment_connections|booking_stripe_connect_states|booking_payment_events|booking_payment_event_replays|restaurant_course_payment_settings|event_payment_settings)\b/.exec(String(error))?.[1];
  const code=!missing?'payment_admin_unavailable':missing==='booking_payment_connections'?'payment_connection_storage_not_ready'
    :missing==='booking_stripe_connect_states'?'stripe_connect_storage_not_ready'
    :['booking_payment_events','booking_payment_event_replays'].includes(missing)?'payment_events_storage_not_ready':'payment_storage_not_ready';
  logger.error(code);
  return c.json({success:false,error:code,code},503);
});

/** 既存の予約支払いと同じ所属・役割。直結した試験でも閲覧のみの変更を拒否する。 */
const guard = (write = false): MiddlewareHandler<Env> => async (c, next) => {
  c.header('Cache-Control','no-store');
  const staff=c.get('staff');
  if (!staff || !['owner','admin','staff'].includes(staff.role) || (write && (staff.readOnly || staff.role==='staff'))) {
    return c.json({success:false,error:'forbidden'},403);
  }
  const account=c.req.query('account_id')?.trim();
  if (!account) return inputError(c,{success:false,error:'missing_account_id'},400,['account_id']);
  if (!await canAccessAllLineAccounts(c.env.DB,staff,[account])) return c.json({success:false,error:'not_found'},404);
  // 所属判定に加え、未作成のアカウントも実在するものとして扱わない。
  if (!await c.env.DB.prepare('SELECT id FROM line_accounts WHERE id=?').bind(account).first()) return c.json({success:false,error:'not_found'},404);
  await next();
};

registerStripeConnectRoutes(bookingPaymentAdmin, guard);

bookingPaymentAdmin.get('/api/booking/admin/stripe-review', guard(), async c => {
  if (!['owner','admin'].includes(c.get('staff')?.role ?? '')) return c.json({success:false,error:'forbidden'},403);
  const raw=c.req.query('cursor');
  if (raw && !/^(0|[1-9][0-9]{0,15}):([1-9][0-9]{0,15})$/.test(raw)) return inputError(c,{success:false,error:'invalid_cursor'},400,['cursor']);
  const parts=raw?.split(':').map(Number);
  if (parts && !parts.every(Number.isSafeInteger)) return inputError(c,{success:false,error:'invalid_cursor'},400,['cursor']);
  const cursor=parts?{createdAt:parts[0]!,rowid:parts[1]!}:null;
  return c.json({success:true,data:await listStripeReviews(c.env.DB,c.req.query('account_id')!.trim(),cursor)});
});

bookingPaymentAdmin.get('/api/booking/admin/payment-connection',guard(),async c => {
  const row=await c.env.DB.prepare(`SELECT provider_account_id,test_mode,connected_at,disconnected_at
    FROM booking_payment_connections WHERE line_account_id=? AND provider='stripe'`)
    .bind(c.req.query('account_id')!.trim()).first<{provider_account_id:string;test_mode:number;connected_at:string;disconnected_at:string|null}>();
  const connected=Boolean(row && !row.disconnected_at);
  return c.json({success:true,data:{connected,testMode:row?Boolean(row.test_mode):true,
    accountIdTail:connected?row!.provider_account_id.slice(-4):null,connectedAt:connected?row!.connected_at:null,dashboardUrl:null}});
});
bookingPaymentAdmin.get('/api/booking/admin/menu-payments',guard(),async c => {
  const rows=await c.env.DB.prepare(`SELECT s.menu_id AS menuId,s.mode FROM booking_payment_menu_settings s
    JOIN menus m ON m.id=s.menu_id AND m.line_account_id=s.line_account_id
    WHERE s.line_account_id=? AND m.deleted_at IS NULL ORDER BY m.sort_order,m.id`)
    .bind(c.req.query('account_id')!.trim()).all<{menuId:string;mode:string}>();
  const other=await c.env.DB.prepare(`SELECT p.menu_id AS menuId,p.mode FROM restaurant_course_payment_settings p
    JOIN rt_menu_items m ON m.id=p.menu_id AND m.store_id=p.store_id AND m.kind='course' AND m.status<>'archived'
    JOIN rt_stores s ON s.id=p.store_id AND s.line_account_id=p.line_account_id
    WHERE p.line_account_id=? AND p.mode IS NOT NULL
    UNION ALL SELECT p.event_id AS menuId,p.mode FROM event_payment_settings p
    JOIN events e ON e.id=p.event_id AND e.line_account_id=p.line_account_id AND e.deleted_at IS NULL
    WHERE p.line_account_id=? AND p.mode IS NOT NULL ORDER BY menuId`)
    .bind(c.req.query('account_id')!.trim(),c.req.query('account_id')!.trim()).all<{menuId:string;mode:string}>();
  return c.json({success:true,data:{menus:[...rows.results,...other.results]}});
});
bookingPaymentAdmin.get('/api/booking/admin/payments',guard(),async c => {
  const filter=paymentRecordFilter(c.req.query());
  if (!filter) return inputError(c,{success:false,error:'invalid_payment_filter'},400,['q','status','method','period','limit','offset']);
  const account=c.req.query('account_id')!.trim();
  const page=await paymentRecords(c.env.DB,account,filter);
  const summary=await paymentSummary(c.env.DB,account);
  return c.json({success:true,data:{...page,summary}});
});
bookingPaymentAdmin.get('/api/booking/admin/payments/export',guard(),async c => {
  const filter=paymentRecordFilter(c.req.query());
  if (!filter) return inputError(c,{success:false,error:'invalid_payment_filter'},400,['q','status','method','period','limit','offset']);
  const page=await paymentRecords(c.env.DB,c.req.query('account_id')!.trim(),{...filter,limit:10000,offset:0});
  // 黙って切り詰めたCSVを渡さない。大量書出しのジョブは別の保存先の承認後に追加する。
  if (page.total>10000) return c.json({success:false,error:'export_too_large',code:'export_too_large',maxRows:10000},413);
  c.header('Content-Type','text/csv; charset=utf-8');
  c.header('Content-Disposition','attachment; filename="booking-payments.csv"');
  return c.body(paymentCsv(page.items));
});
bookingPaymentAdmin.get('/api/booking/admin/staff/today-counts',guard(),async c =>
  c.json({success:true,data:await staffTodayCounts(c.env.DB,c.req.query('account_id')!.trim())}));

bookingPaymentAdmin.post('/api/booking/admin/payments/:id/send-link',guard(true),inputJsonBoundary(),async c => {
  const body=await c.req.json<{dryRun?:unknown}>().catch(()=>null);
  if (body?.dryRun!==true) return inputError(c,{success:false,error:'simulation_only',code:'simulation_only'},400,['dryRun']);
  const account=c.req.query('account_id')!.trim();
  const row=await c.env.DB.prepare(`SELECT b.id,b.line_account_id,b.price_at_booking,b.status,p.provider,p.idempotency_key
    FROM booking_payments p JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=p.line_account_id
    WHERE p.id=? AND p.line_account_id=? AND p.status IN ('unpaid','pending')
      AND (p.hold_until IS NULL OR julianday(p.hold_until)>julianday(?))`)
    .bind(c.req.param('id'),account,new Date().toISOString()).first<{id:string;line_account_id:string;price_at_booking:number;status:string;provider:string;idempotency_key:string}>();
  if (!row) return c.json({success:false,error:'payment_not_available'},404);
  if (row.provider!=='stripe') return c.json({success:false,error:'simulation_only',code:'simulation_only'},409);
  // 既存の開始処理を使い、リンクを重複作成しない。LINEや外部Stripeへ通信しない。
  const result=await startBookingPayment(c.env.DB,c.env,row,row.idempotency_key);
  if (!result.ok) return c.json({success:false,error:result.error},result.status);
  return c.json({success:true,data:{paymentId:result.paymentId,checkoutUrl:result.checkoutUrl,sent:false,simulation:true}});
});

bookingPaymentAdmin.get('/api/booking/admin/payment-events',guard(),async c => {
  const filter=paymentEventFilter(c.req.query());
  if (!filter) return inputError(c,{success:false,error:'invalid_payment_event_filter'},400,['result','period','limit']);
  return c.json({success:true,data:await paymentEventList(c.env.DB,c.req.query('account_id')!.trim(),filter)});
});
bookingPaymentAdmin.post('/api/booking/admin/payment-events/:id/replay',guard(true),inputJsonBoundary(),async c => {
  const account=c.req.query('account_id')!.trim(),id=c.req.param('id');
  if (!await paymentEvent(c.env.DB,account,id)) return c.json({success:false,error:'not_found'},404);
  const result=await processPaymentEvent(c.env.DB,account,id,c.get('staff').id);
  if (result.status==='busy_or_missing') return c.json({success:false,error:'payment_event_busy',code:'payment_event_busy'},409);
  const data=await paymentEvent(c.env.DB,account,id);
  if (result.result==='failed') return c.json({success:false,error:'payment_event_apply_failed',code:'payment_event_apply_failed',data},503);
  return c.json({success:true,data});
});

for (const suffix of ['payment','price'] as const) {
  const path=`/api/events/admin/events/:id/${suffix}`;
  const eventGuard: MiddlewareHandler<Env> = async (c,next) => {
    const event=await c.env.DB.prepare('SELECT id FROM events WHERE id=? AND line_account_id=? AND deleted_at IS NULL')
      .bind(c.req.param('id'),c.req.query('account_id')!.trim()).first();
    if (!event) return c.json({success:false,error:'not_found'},404);
    return next();
  };
  const handle: MiddlewareHandler<Env> = c => paymentSettingResponse(c,c.env.DB,
    {kind:'event',id:c.req.param('id')!,account:c.req.query('account_id')!.trim()},suffix==='price'?'unitPrice':'mode');
  bookingPaymentAdmin.get(path,guard(),eventGuard,handle);
  bookingPaymentAdmin.put(path,guard(true),eventGuard,inputJsonBoundary(),handle);
}
