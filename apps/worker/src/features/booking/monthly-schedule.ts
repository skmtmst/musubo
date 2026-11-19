import { tzDateStr } from '../../services/availability.js';
import { restaurantCivilTime } from '../../services/restaurant-booking.js';

/** 店の暦の1日に当月の請求予定を1件だけ記録する。外部請求は行わない。 */
export async function scheduleMonthlyRenewals(db: D1Database, now = new Date()) {
  const rows = (await db.prepare(`SELECT c.id,c.tenant_id,c.account_id,c.connected_account,c.timezone,c.amount
    FROM booking_monthly_contracts c JOIN line_accounts a ON a.id=c.account_id AND a.tenant_id=c.tenant_id
    JOIN tenants t ON t.id=c.tenant_id
    WHERE c.state IN ('active','stop_scheduled') AND c.service_state='enabled' AND c.test_mode=1
      AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'
    ORDER BY c.id`).all<{id:string;tenant_id:string;account_id:string;connected_account:string;timezone:string;amount:number}>()).results;
  let scheduled = 0;
  for (const c of rows) {
    const day = tzDateStr(c.timezone, now);
    if (!day.endsWith('-01')) continue;
    const month = day.slice(0, 7);
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const start = restaurantCivilTime(day, 0, c.timezone), end = restaurantCivilTime(next, 0, c.timezone);
    const at = now.toISOString();
    const result = await db.prepare(`INSERT INTO booking_monthly_cycles
      (id,contract_id,tenant_id,account_id,connected_account,month_key,kind,due_at,period_start,service_start,service_end,amount,created_at,updated_at)
      SELECT ?,c.id,c.tenant_id,c.account_id,c.connected_account,?,'renewal',?,?,?,?,c.amount,?,?
      FROM booking_monthly_contracts c JOIN line_accounts a ON a.id=c.account_id AND a.tenant_id=c.tenant_id
      JOIN tenants t ON t.id=c.tenant_id WHERE c.id=? AND c.state IN ('active','stop_scheduled')
      AND c.service_state='enabled' AND c.test_mode=1 AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'
      AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday(?))
      ON CONFLICT(contract_id,month_key) DO NOTHING`).bind(crypto.randomUUID(),month,start,start,start,end,at,at,c.id,start).run();
    scheduled += result.meta.changes;
  }
  return { scheduled };
}
