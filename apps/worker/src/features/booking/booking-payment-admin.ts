import { getBookingPaymentConfig } from '@line-crm/db';
import { getAccountTimeZone } from '../../services/availability.js';
import { assignmentWindows } from './booking-assignment.js';
import { entitlementMonth } from './booking-entitlements.js';

export interface PaymentRecordFilter {
  q: string; status: string; method: string; period: string; limit: number; offset: number;
}
export interface AdminPaymentRecord {
  id: string; bookingId: string | null; friendId: string | null; friendName: string | null;
  bookingStartsAt: string | null; bookingLabel: string | null; bookingNote: string | null;
  amount: number; status: 'paid' | 'partially_refunded' | 'pending' | 'refunded' | 'expired' | 'onsite';
  method: string | null; createdAt: string; receiptUrl: string | null;
  refundedAmount: number; actorLabel: string | null; reason: string | null; confirmationRevision: number | null;
}
export function paymentRecordFilter(query: Record<string, string>): PaymentRecordFilter | null {
  const integer = (value: string | undefined, fallback: number, max: number) => value === undefined ? fallback
    : /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) <= max ? Number(value) : NaN;
  const filter = { q: (query.q ?? '').trim(), status: query.status ?? '', method: query.method ?? '',
    period: query.period || 'month', limit: integer(query.limit, 20, 100), offset: integer(query.offset, 0, 100000) };
  return filter.q.length <= 200 && ['', 'paid', 'partially_refunded', 'pending', 'refunded', 'expired', 'onsite'].includes(filter.status)
    && ['', 'online', 'onsite'].includes(filter.method) && ['month', '7d', '30d', '90d'].includes(filter.period)
    && filter.limit >= 1 && filter.offset >= 0 ? filter : null;
}

// 店払いは予約時に保存した選択だけを載せる。現在の店設定から過去の支払いを推測しない。
// 決済失敗はDの表示型に無いのでこの一覧に含めない（pending/expiredへ偽装しない）。
const recordsCte = `WITH records AS (
 SELECT p.id,p.booking_id AS bookingId,b.friend_id AS friendId,f.display_name AS friendName,
 b.starts_at AS bookingStartsAt,m.name AS bookingLabel,b.internal_note AS bookingNote,p.amount,
 CASE WHEN p.status IN ('unpaid','pending') THEN 'pending' WHEN p.status='paid' AND p.refunded_amount>0 THEN 'partially_refunded' ELSE p.status END AS status,
 'online' AS method,p.created_at AS createdAt,p.receipt_url AS receiptUrl,p.refunded_amount AS refundedAmount,p.actor_label AS actorLabel,p.action_reason AS reason,p.confirmation_revision AS confirmationRevision
 FROM booking_payments p LEFT JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=p.line_account_id
 LEFT JOIN friends f ON f.id=b.friend_id AND f.line_account_id=p.line_account_id
 LEFT JOIN menus m ON m.id=b.menu_id AND m.line_account_id=p.line_account_id
 WHERE p.line_account_id=? AND p.status IN ('unpaid','pending','paid','refunded','expired')
 UNION ALL
 SELECT 'onsite:'||b.id,b.id,b.friend_id,f.display_name,b.starts_at,m.name,b.internal_note,b.price_at_booking,
 'onsite','onsite',b.requested_at,NULL,0,NULL,NULL,NULL
 FROM booking_payment_choices ch JOIN bookings b ON b.id=ch.booking_id AND b.line_account_id=ch.line_account_id
 LEFT JOIN friends f ON f.id=b.friend_id AND f.line_account_id=b.line_account_id
 LEFT JOIN menus m ON m.id=b.menu_id AND m.line_account_id=b.line_account_id
 WHERE ch.line_account_id=? AND ch.mode='onsite' AND b.status IN ('requested','confirmed','completed')
 AND NOT EXISTS(SELECT 1 FROM booking_payments p WHERE p.booking_id=b.id AND p.line_account_id=b.line_account_id)
)`;

export async function paymentPeriod(db: D1Database, account: string, period: string, now = new Date()) {
  const timezone = await getAccountTimeZone(db, account);
  if (period === 'today') { const w=assignmentWindows(now.toISOString(),timezone,'day'); return {from:w.dayFrom,to:w.dayTo}; }
  if (period === 'month') { const m = entitlementMonth(now.toISOString(), timezone); return { from: m.periodStart, to: m.periodEnd }; }
  return { from: new Date(now.getTime() - Number(period.slice(0, -1)) * 86400000).toISOString(), to: now.toISOString() };
}

export async function paymentRecords(db: D1Database, account: string, filter: PaymentRecordFilter, now = new Date()) {
  const period = await paymentPeriod(db, account, filter.period, now);
  const where = ` WHERE julianday(createdAt)>=julianday(?) AND julianday(createdAt)<julianday(?)
    AND (?='' OR status=?) AND (?='' OR method=?)
    AND (?='' OR instr(lower(COALESCE(friendName,'')||' '||COALESCE(bookingLabel,'')||' '||COALESCE(bookingId,'')),lower(?))>0)`;
  const bindings = [account, account, period.from, period.to, filter.status, filter.status, filter.method, filter.method, filter.q, filter.q];
  const rows = await db.prepare(`${recordsCte} SELECT * FROM records${where} ORDER BY julianday(createdAt) DESC,id LIMIT ? OFFSET ?`)
    .bind(...bindings, filter.limit, filter.offset).all<AdminPaymentRecord>();
  const count = await db.prepare(`${recordsCte} SELECT COUNT(*) AS total FROM records${where}`).bind(...bindings).first<{total:number}>();
  return { items: rows.results, total: count?.total ?? 0 };
}

/** 集計は検索・ページ・一覧の期間と独立した店の今月。入金総額と返金額は別々に数える。 */
export async function paymentSummary(db: D1Database, account: string, now = new Date(), period: 'month' | 'today' = 'month', staffId?: string) {
  return paymentSummaryInWindow(db, account, await paymentPeriod(db, account, period, now), staffId);
}

/** 検証済みのアカウントと半開期間で決済日を集計する。 */
export async function paymentSummaryInWindow(db: D1Database, account: string, window: { from: string; to: string }, staffId?: string) {
  const { from, to } = window;
  const start = Date.parse(from), end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('invalid_payment_window');
  const rows = await db.prepare(`SELECT p.id,EXISTS(SELECT 1 FROM booking_payment_refunds r WHERE r.payment_id=p.id) AS has_refunds,p.amount,p.status,p.paid_at,p.updated_at,COALESCE(p.refunded_at,p.updated_at) AS refunded_at,p.created_at,b.status AS booking_status
    FROM booking_payments p LEFT JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=p.line_account_id
    WHERE p.line_account_id=? AND (? IS NULL OR b.staff_id=?) AND (
      (julianday(p.paid_at)>=julianday(?) AND julianday(p.paid_at)<julianday(?)) OR
      (julianday(COALESCE(p.refunded_at,p.updated_at))>=julianday(?) AND julianday(COALESCE(p.refunded_at,p.updated_at))<julianday(?)) OR
      (julianday(p.created_at)>=julianday(?) AND julianday(p.created_at)<julianday(?)))`)
    .bind(account, staffId??null, staffId??null, from, to, from, to, from, to).all<{
      id:string; has_refunds:number; amount:number; status:string; paid_at:string|null; updated_at:string; refunded_at:string; created_at:string; booking_status:string|null;
    }>();
  const inWindow = (at: string | null) => at !== null && Date.parse(at) >= start && Date.parse(at) < end;
  const summary = { paidAmount:0, paidCount:0, refundedAmount:0, refundedCount:0, expiredCount:0, pendingCount:0,
    holdMinutes:(await getBookingPaymentConfig(db, account)).holdMinutes };
  const ledger = await db.prepare(`SELECT r.payment_id,r.amount,r.created_at FROM booking_payment_refunds r LEFT JOIN booking_payments p ON p.id=r.payment_id LEFT JOIN bookings b ON b.id=p.booking_id AND b.line_account_id=p.line_account_id WHERE r.line_account_id=? AND (? IS NULL OR b.staff_id=?) AND julianday(r.created_at)>=julianday(?) AND julianday(r.created_at)<julianday(?)`)
    .bind(account,staffId??null,staffId??null,from,to).all<{payment_id:string;amount:number;created_at:string}>();
  const refundedPayments = new Set<string>();
  for (const row of ledger.results) if (inWindow(row.created_at)) {
    summary.refundedAmount+=row.amount; refundedPayments.add(row.payment_id);
  }
  summary.refundedCount=refundedPayments.size;
  for (const row of rows.results) {
    if (['paid','refunded'].includes(row.status) && inWindow(row.paid_at)) { summary.paidAmount += row.amount; summary.paidCount++; }
    // 移行前の返金は元のupdated_atを使う。新規返金は固定した返金日時を使う。
    if (row.status==='refunded' && !row.has_refunds && inWindow(row.refunded_at)) { summary.refundedAmount+=row.amount; summary.refundedCount++; }
    if (row.status==='expired' && row.booking_status==='expired' && inWindow(row.updated_at)) summary.expiredCount++;
    if (['unpaid','pending'].includes(row.status) && inWindow(row.created_at)) summary.pendingCount++;
  }
  return summary;
}

/** 表計算で実行される数式を防ぎ、改行・引用符・日本語を保つ。 */
export function paymentCsv(items: AdminPaymentRecord[]) {
  const cell = (v: unknown) => { const s=String(v ?? ''); return `"${(/^[\s\u0000-\u001f]*[=+@-]/u.test(s) ? "'"+s : s).replace(/"/g,'""')}"`; };
  const rows: unknown[][] = [['記録ID','予約ID','お客さま','予約日時','メニュー','金額','状態','方法','作成日時','返金額','操作した人','理由']];
  for (const p of items) rows.push([p.id,p.bookingId,p.friendName,p.bookingStartsAt,p.bookingLabel,p.amount,p.status,p.method,p.createdAt,p.refundedAmount,p.actorLabel,p.reason]);
  return '\uFEFF'+rows.map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n';
}

export async function staffTodayCounts(db: D1Database, account: string, now = new Date()) {
  const timezone = await getAccountTimeZone(db, account);
  const w=assignmentWindows(now.toISOString(),timezone,'day');
  const rows=await db.prepare(`SELECT s.id AS staffId,COUNT(b.id) AS todayCount FROM staff s
    LEFT JOIN bookings b ON b.staff_id=s.id AND b.line_account_id=s.line_account_id
      AND b.status IN ('requested','confirmed','completed')
      AND julianday(b.starts_at)>=julianday(?) AND julianday(b.starts_at)<julianday(?)
    WHERE s.line_account_id=? AND s.deleted_at IS NULL GROUP BY s.id ORDER BY s.sort_order,s.id`)
    .bind(w.dayFrom,w.dayTo,account).all<{staffId:string;todayCount:number}>();
  return { items: rows.results, date: new Intl.DateTimeFormat('sv-SE',{timeZone:timezone}).format(now), timezone };
}

/** 支払一覧と同じ保存済み記録・状態名を使い、作成日で対象を落とさない。 */
export async function paymentBadges(db:D1Database,account:string,bookingIds:string[]) {
 const byBooking=new Map<string,{bookingId:string;status:AdminPaymentRecord['status'];method:string|null;amount:number}>();
 const ids=[...new Set(bookingIds)];
 for(let start=0;start<ids.length;start+=80) {
  const chunk=ids.slice(start,start+80);
  const rows=await db.prepare(`${recordsCte} SELECT bookingId,status,method,amount FROM records WHERE bookingId IN(${chunk.map(()=>'?').join(',')}) ORDER BY julianday(createdAt) DESC,id`).bind(account,account,...chunk).all<{bookingId:string;status:AdminPaymentRecord['status'];method:string|null;amount:number}>();
  for(const row of rows.results)if(!byBooking.has(row.bookingId))byBooking.set(row.bookingId,row);
 }
 return byBooking;
}
