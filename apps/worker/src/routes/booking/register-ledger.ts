import { parseOffsetPaging, buildOffsetListResponse } from '../../lib/list-paging.js';
import { jstDate as japanDate } from '@line-crm/shared';
import type { Env } from '../../worker-env.js';
import type { Hono } from 'hono';
import { hasStaffPermission } from '../../middleware/role-guard.js';
import { listResponse } from '../../lib/list-etag.js';
import { inputJsonBoundary } from '../../lib/input-errors.js';
import { resolveAccountIdAdmin } from './identity.js';
import { bookingLedgerFilter, BOOKING_LEDGER_JOINS, BOOKING_CSV_EXPORT_LIMIT, csvNoteValue, BOOKING_CSV_STATUS_LABEL, BOOKING_CSV_SOURCE_LABEL, csvTimestamp, csvCell } from './ledger-input.js';

export function registerLedger(booking: Hono<Env>): void {
booking.get('/api/booking/admin/requests', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const { limit, offset } = parseOffsetPaging({ limit: c.req.query('limit') || undefined, offset: c.req.query('offset') || undefined }, { defaultLimit: 50, limitPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 1, maximum: 100 }, offsetPolicy: { format: 'integer-prefix', fallback: 'falsy', minimum: 0 } });
  const reception = c.req.query('reception');
  const { where, values } = bookingLedgerFilter(c, accountId, Boolean(reception));
  if (reception && !['all', 'requested', 'unassigned', 'attention'].includes(reception)) return c.json({ error: 'invalid_reception_filter' }, 400);
  if (reception) {
    const base = `${where} AND b.status IN ('requested','confirmed')`;
    const unassigned = "b.assignment_method = 'automatic' AND b.assignment_reviewed_at IS NULL";
    const attention = `(b.status = 'requested' OR (${unassigned}))`;
    const selected = reception === 'requested' ? " AND b.status = 'requested'" : reception === 'unassigned' ? ` AND ${unassigned}` : reception === 'attention' ? ` AND ${attention}` : '';
    const [rows, totals, count] = await Promise.all([
      c.env.DB.prepare(`SELECT b.*, m.name AS menu_name, s.display_name AS staff_name, COALESCE(f.display_name,bc.display_name) AS friend_name, bc.phone_last4 AS customer_phone_last4, bc.pet_name AS customer_pet_name, CASE WHEN f.id IS NULL THEN 0 ELSE 1 END AS is_line_linked ${BOOKING_LEDGER_JOINS} ${base}${selected} ORDER BY CASE WHEN ${attention} THEN 0 ELSE 1 END, b.starts_at ASC, b.id ASC LIMIT ? OFFSET ?`).bind(...values, limit, offset).all(),
      c.env.DB.prepare(`SELECT SUM(CASE WHEN b.status='requested' THEN 1 ELSE 0 END) AS requested, SUM(CASE WHEN ${unassigned} THEN 1 ELSE 0 END) AS unassigned, SUM(CASE WHEN ${attention} THEN 1 ELSE 0 END) AS attention, SUM(CASE WHEN b.assignment_method='unknown' THEN 1 ELSE 0 END) AS unknown ${BOOKING_LEDGER_JOINS} ${base}`).bind(...values).first<{requested:number|null;unassigned:number|null;attention:number|null;unknown:number|null}>(),
      c.env.DB.prepare(`SELECT COUNT(*) AS total ${BOOKING_LEDGER_JOINS} ${base}${selected}`).bind(...values).first<{total:number}>(),
    ]);
    return listResponse(c, { requests: rows.results, total: Number(count?.total ?? 0), requestedCount: Number(totals?.requested ?? 0), unassignedCount: Number(totals?.unassigned ?? 0), attentionCount: Number(totals?.attention ?? 0), unknownCount: Number(totals?.unknown ?? 0), limit, offset });
  }
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT b.*, m.name AS menu_name, s.display_name AS staff_name,
              COALESCE(f.display_name, bc.display_name) AS friend_name,
              bc.phone_last4 AS customer_phone_last4,
              bc.pet_name AS customer_pet_name,
              CASE WHEN f.id IS NULL THEN 0 ELSE 1 END AS is_line_linked
         ${BOOKING_LEDGER_JOINS} ${where}
        ORDER BY b.starts_at ASC LIMIT ? OFFSET ?`,
    ).bind(...values, limit, offset).all(),
    c.env.DB.prepare(`SELECT COUNT(*) AS total ${BOOKING_LEDGER_JOINS} ${where}`)
      .bind(...values).first<{ total: number }>(),
  ]);
  // 同じ中身なら304（list-etag）。
  const responseItems = rows.results;
  return listResponse(c, buildOffsetListResponse({ requests: responseItems, total: Number(count?.total ?? 0), limit, offset, items: responseItems, paging: { limit, offset }, sort: [{ field: 'starts_at', direction: 'asc' }] }));
});

// 自動で選ばれた担当者を確認したことを、表示中の版に限って記録する。
booking.post('/api/booking/admin/requests/:id/assignment-review', inputJsonBoundary(), async (c) => {
  if (!hasStaffPermission(c, '/booking/bookings')) return c.json({ error: 'permission_denied' }, 403);
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const body = await c.req.json<{ lock_version?: unknown }>().catch(() => null);
  if (!body || !Number.isInteger(body.lock_version) || Number(body.lock_version) < 0) return c.json({ error: 'invalid_lock_version' }, 400);
  const result = await c.env.DB.prepare(`UPDATE bookings SET assignment_reviewed_at=?, lock_version=lock_version+1, updated_at=? WHERE id=? AND line_account_id=? AND lock_version=? AND assignment_method='automatic' AND assignment_reviewed_at IS NULL AND status IN ('requested','confirmed')`).bind(new Date().toISOString(), new Date().toISOString(), c.req.param('id'), accountId, body.lock_version).run();
  if (!result.meta.changes) return c.json({ error: 'version_conflict' }, 409);
  return c.json({ success: true });
});

/**
 * 予約台帳のCSV書出し。
 *
 * 一覧と同じ絞り込み（状態・検索語・メニュー・担当者・種別・期間）を
 * bookingLedgerFilter で組み立てるので、画面に見えている分だけが出る。
 * 件数は BOOKING_CSV_EXPORT_LIMIT まで。閲覧権限は一覧と同じでよい
 * （読み取りの別形式）ため、staff ロールは /booking/bookings の
 * 閲覧・編集どちらのキーでも通す。所属外アカウントは共通ミドルウェアで403。
 */
booking.get('/api/booking/admin/bookings.csv', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  // 閲覧できる人は書き出せる（読み取りの別形式）。owner/admin は常に通し、
  // staff は編集キーまたは GET なので閲覧キーで通す。一覧と同じ門番。
  if (!hasStaffPermission(c, '/booking/bookings')) {
    return c.json({ error: 'permission_denied' }, 403);
  }
  const { where, values } = bookingLedgerFilter(c, accountId);
  const rows = await c.env.DB.prepare(
    `SELECT b.id, b.status, b.source, b.starts_at, b.ends_at, b.requested_at,
            b.price_at_booking, b.customer_note, b.internal_note,
            m.name AS menu_name, s.display_name AS staff_name,
            COALESCE(f.display_name, bc.display_name) AS friend_name
       ${BOOKING_LEDGER_JOINS} ${where}
      ORDER BY b.starts_at ASC LIMIT ?`,
  ).bind(...values, BOOKING_CSV_EXPORT_LIMIT + 1)
    .all<{
      id: string; status: string; source: string | null;
      starts_at: string; ends_at: string | null; requested_at: string;
      price_at_booking: number | null;
      customer_note: string | null; internal_note: string | null;
      menu_name: string; staff_name: string; friend_name: string | null;
    }>();
  const all = rows.results ?? [];
  const truncated = all.length > BOOKING_CSV_EXPORT_LIMIT;
  const exportRows = truncated ? all.slice(0, BOOKING_CSV_EXPORT_LIMIT) : all;
  c.set('outputAudit', { count: exportRows.length, accountId });

  const status = csvNoteValue(c.req.query('status') || 'requested');
  const filterNote = [
    `状態=${status === 'all' ? 'すべて' : (BOOKING_CSV_STATUS_LABEL[status] ?? status)}`,
    c.req.query('staff_id')?.trim() ? `担当者=指定` : null,
    c.req.query('source')?.trim() ? `種別=${BOOKING_CSV_SOURCE_LABEL[c.req.query('source')!.trim()] ?? csvNoteValue(c.req.query('source')!.trim())}` : null,
    c.req.query('menu_name')?.trim() ? `メニュー=${csvNoteValue(c.req.query('menu_name')!.trim())}` : null,
    c.req.query('query')?.trim() ? `検索語=${csvNoteValue(c.req.query('query')!.trim())}` : null,
    `期間=${csvNoteValue(c.req.query('from')?.trim() || '指定なし')}〜${csvNoteValue(c.req.query('to')?.trim() || '指定なし')}`,
  ].filter(Boolean).join(' / ');
  const headerNote = truncated
    ? `# 予約台帳の書出し（${filterNote}）…先頭${BOOKING_CSV_EXPORT_LIMIT}件まで。続きは期間や絞り込みを分けて出してください。`
    : `# 予約台帳の書出し（${filterNote}）…最大${BOOKING_CSV_EXPORT_LIMIT}件まで`;

  const headers = [
    '予約ID', 'お客さま名', 'メニュー', '担当者', '予約経路',
    '開始日時(JST)', '終了日時(JST)', '状態', '料金', '申込日時(JST)',
    'お客様からのご希望', '社内メモ',
  ];
  const body = exportRows.map((row) => [
    row.id,
    row.friend_name ?? '',
    row.menu_name,
    row.staff_name,
    BOOKING_CSV_SOURCE_LABEL[row.source ?? ''] ?? row.source ?? '',
    csvTimestamp(row.starts_at),
    csvTimestamp(row.ends_at),
    BOOKING_CSV_STATUS_LABEL[row.status] ?? row.status,
    row.price_at_booking ?? '',
    csvTimestamp(row.requested_at),
    row.customer_note ?? '',
    row.internal_note ?? '',
  ].map(csvCell).join(','));
  const csv = `${[headerNote, headers.map(csvCell).join(','), ...body].join('\r\n')}\r\n`;
  const date = japanDate().replaceAll('-', '');
  return new Response(`\uFEFF${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="booking-ledger-${date}.csv"`,
      'Cache-Control': 'private, no-store',
    },
  });
});

booking.get('/api/booking/admin/requests-summary', async (c) => {
  const accountId = await resolveAccountIdAdmin(c);
  if (!accountId) return c.json({ error: 'missing_account_id' }, 400);
  const thisMonth = c.req.query('month') || '';
  const lastMonth = c.req.query('last_month') || '';
  const today = c.req.query('today') || '';
  const weekTo = c.req.query('week_to') || '';
  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'requested' THEN 1 ELSE 0 END) AS requested,
            SUM(CASE WHEN substr(datetime(starts_at, '+9 hours'), 1, 7) = ? THEN 1 ELSE 0 END) AS month_total,
            SUM(CASE WHEN substr(datetime(starts_at, '+9 hours'), 1, 7) = ? AND status = 'confirmed' THEN 1 ELSE 0 END) AS month_confirmed,
            SUM(CASE WHEN substr(datetime(starts_at, '+9 hours'), 1, 7) = ? AND status IN ('cancelled','rejected','no_show') THEN 1 ELSE 0 END) AS month_cancelled,
            SUM(CASE WHEN substr(datetime(starts_at, '+9 hours'), 1, 7) = ? THEN 1 ELSE 0 END) AS last_month_total,
            SUM(CASE WHEN date(datetime(starts_at, '+9 hours')) = ? THEN 1 ELSE 0 END) AS today_total,
            /*
             * ダッシュボードの「今日の予約」カードが使う専用集計（A01-04）。
             * 明細取得の上限(100件)に引っ張られず、取消・完了・無断を除いた
             * 「今日対応する予約」の総数を返す。
             */
            SUM(CASE WHEN date(datetime(starts_at, '+9 hours')) = ?
                     AND status NOT IN ('rejected','cancelled','canceled','completed','no_show')
                     THEN 1 ELSE 0 END) AS today_active_total,
            SUM(CASE WHEN date(datetime(starts_at, '+9 hours')) BETWEEN ? AND ? THEN 1 ELSE 0 END) AS week_total,
            /*
             * 表示タブ（今日・今週・今月）の数。カレンダーと同じ基準で
             * 取消・拒否・期限切れを除いた「有効な予約」だけ数える。
             * KPI・解約率に使う従来の集計（month_total 等）は変えない。
             */
            SUM(CASE WHEN date(datetime(starts_at, '+9 hours')) = ?
                     AND status NOT IN ('cancelled','canceled','rejected','expired')
                     THEN 1 ELSE 0 END) AS today_tab_total,
            SUM(CASE WHEN date(datetime(starts_at, '+9 hours')) BETWEEN ? AND ?
                     AND status NOT IN ('cancelled','canceled','rejected','expired')
                     THEN 1 ELSE 0 END) AS week_tab_total,
            SUM(CASE WHEN substr(datetime(starts_at, '+9 hours'), 1, 7) = ?
                     AND status NOT IN ('cancelled','canceled','rejected','expired')
                     THEN 1 ELSE 0 END) AS month_tab_total
       FROM bookings WHERE line_account_id = ?`,
  ).bind(thisMonth, thisMonth, thisMonth, lastMonth, today, today, today, weekTo,
    today, today, weekTo, thisMonth, accountId).first<Record<string, number>>();
  const byMenu = await c.env.DB.prepare(
    `SELECT m.name, COUNT(*) AS total FROM bookings b
       INNER JOIN menus m ON m.id = b.menu_id
      WHERE b.line_account_id = ? GROUP BY m.id, m.name`,
  ).bind(accountId).all<{ name: string; total: number }>();
  return c.json({
    total: Number(totals?.total ?? 0), requested: Number(totals?.requested ?? 0),
    monthTotal: Number(totals?.month_total ?? 0), monthConfirmed: Number(totals?.month_confirmed ?? 0),
    monthCancelled: Number(totals?.month_cancelled ?? 0), lastMonthTotal: Number(totals?.last_month_total ?? 0),
    todayTotal: Number(totals?.today_total ?? 0),
    todayActiveTotal: Number(totals?.today_active_total ?? 0),
    weekTotal: Number(totals?.week_total ?? 0),
    todayTabTotal: Number(totals?.today_tab_total ?? 0),
    weekTabTotal: Number(totals?.week_tab_total ?? 0),
    monthTabTotal: Number(totals?.month_tab_total ?? 0),
    byMenu: byMenu.results.map((row) => ({ name: row.name, total: Number(row.total) })),
  });
});
}
