import { createMonthlyInvoice, type MonthlyInvoiceProvider } from './monthly-invoice.js';

/** 試験用の請求口を明示して呼ぶ。結果不明・処理中は再送しない。 */
export async function dispatchMonthlyInvoices(db: D1Database, provider: MonthlyInvoiceProvider, now = new Date(), options: { testRecipientsOnly?: boolean } = {}) {
  const rows = (await db.prepare(`SELECT y.id FROM booking_monthly_cycles y
    JOIN booking_monthly_contracts c ON c.id=y.contract_id AND c.account_id=y.account_id AND c.tenant_id=y.tenant_id
    JOIN line_accounts a ON a.id=c.account_id AND a.tenant_id=c.tenant_id
    JOIN tenants t ON t.id=c.tenant_id
    WHERE y.state='planned' AND y.test_mode=1 AND c.test_mode=1 AND julianday(y.due_at)<=julianday(?)
    AND c.state IN ('applying','active','stop_scheduled') AND c.service_state='enabled' AND c.customer_id IS NOT NULL
    AND (c.stop_effective_at IS NULL OR julianday(c.stop_effective_at)>julianday(y.service_start))
    AND a.is_active=1 AND a.archived_at IS NULL AND t.status='active'
    AND (?=0 OR EXISTS(SELECT 1 FROM account_settings s, json_each(CASE WHEN json_valid(s.value) THEN CASE WHEN json_type(s.value)='array' THEN s.value ELSE '[]' END ELSE '[]' END) j
      WHERE s.line_account_id=c.account_id AND s.key='test_recipients' AND j.value=c.friend_id))
    ORDER BY y.due_at,y.id LIMIT 100`).bind(now.toISOString(),options.testRecipientsOnly ? 1 : 0).all<{id:string}>()).results;
  let created = 0, unknown = 0;
  for (const row of rows) {
    const result = await createMonthlyInvoice(db, row.id, provider, now);
    if (result.status === 'created') created++;
    if (result.status === 'unknown') unknown++;
  }
  return { created, unknown };
}
