import type { HqAttentionCounts, HqAttentionKind } from '@line-crm/shared';

/** 呼び出し元で、このアカウントが現在の可視範囲に属することを検証する。 */
export async function readAccountAttention(
  db: D1Database,
  a: string,
  includeDetails = true,
  detailLimit: 1 | 100 = 100,
) {
  const queries: Record<string, string> = {
    unhandledChats: `SELECT c.id,'/chats' href FROM chats c JOIN friends f ON f.id=c.friend_id WHERE f.line_account_id=? AND c.status IN('unread','in_progress','on_hold')`,
    pendingBookings: `SELECT id,'/booking/bookings' href FROM bookings WHERE line_account_id=? AND status='requested' UNION ALL SELECT id,'/events/bookings' href FROM event_bookings WHERE line_account_id=? AND status='requested' UNION ALL SELECT r.id,'/restaurant-test/reservations' href FROM rt_reservations r JOIN rt_stores s ON s.id=r.store_id WHERE s.line_account_id=? AND r.status='pending' AND r.hold_expires_at IS NULL`,
    unpaid: `SELECT id FROM booking_payments WHERE line_account_id=? AND status IN('unpaid','pending','failed')`,
    connections: `SELECT id,'/accounts' href FROM line_account_connection_checks c WHERE line_account_id=? AND result IN('failed','mismatched','unconfigured') AND NOT EXISTS(SELECT 1 FROM line_account_connection_checks n WHERE n.line_account_id=c.line_account_id AND n.check_kind=c.check_kind AND n.checked_at>c.checked_at)`,
    stoppedDeliveries: `SELECT id,'/broadcasts' href FROM broadcasts WHERE line_account_id=? AND status IN('stopped','failed')`,
  };

  const entries = Object.entries(queries);
  const statements = entries.flatMap(([kind, sql]) => {
    const bindings = Array.from(
      { length: kind === 'pendingBookings' ? 3 : 1 },
      () => a,
    );
    const count = db.prepare(`SELECT COUNT(*) count FROM (${sql})`).bind(...bindings);
    if (includeDetails) {
      return [count, db.prepare(sql + ` LIMIT ${detailLimit}`).bind(...bindings)];
    }
    // 件数から開く行き先は、明細の既存の行き先と分けて維持する。
    const targetSql = sql
      .replace("'/chats' href", "'/chats?status='||c.status href")
      .replace("'/booking/bookings' href", "'/booking/bookings?view=list&status=requested' href")
      .replace("'/events/bookings' href", "'/events/bookings?id='||event_id href")
      .replace("'/restaurant-test/reservations' href", "'/restaurant-test/reservations?view=list' href")
      .replace('SELECT id FROM booking_payments', "SELECT id,'/booking/menus?tab=payments&view=records' href FROM booking_payments");
    return [count, db.prepare(`SELECT href,COUNT(*) count FROM (${targetSql}) GROUP BY href ORDER BY href`).bind(...bindings)];
  });
  // 1アカウントの集計と行き先を1往復で読み、件数と明細の読み取り時点もそろえる。
  const results = await db.batch(statements);
  const targets: Partial<Record<HqAttentionKind, Array<{ href: string; count: number }>>> = {};
  const counts: Record<string, number> = {};
  const details: Record<string, unknown[]> = {};
  entries.forEach(([kind], index) => {
    counts[kind] = (results[index * 2].results[0] as { count: number } | undefined)?.count ?? 0;
    const rows = results[index * 2 + 1].results;
    if (includeDetails) {
      details[kind] = rows;
    } else {
      targets[kind as HqAttentionKind] = (rows as Array<{ href: string; count: number }>).map(
        target => target.href.startsWith('/events/bookings?id=')
          ? { ...target, href: '/events/bookings?id=' + encodeURIComponent(target.href.slice('/events/bookings?id='.length)) }
          : target,
      );
    }
  });
  return { counts: counts as HqAttentionCounts, details, targets };
}
