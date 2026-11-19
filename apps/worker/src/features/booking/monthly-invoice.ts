/** 試験用の請求口。実接続は別途、同じ冪等キーで結果照合できる実装を渡す。 */
export interface MonthlyInvoiceProvider {
  create(input: { account: string; customer: string; amount: number; currency: 'jpy'; idempotencyKey: string }): Promise<{
    id: string; livemode: boolean; autoAdvance: boolean; status: 'draft' | 'open';
  }>;
}

/** planned を原子的に確保し、結果不明時は自動再請求しない。 */
export async function createMonthlyInvoice(db: D1Database, cycleId: string, provider: MonthlyInvoiceProvider, now = new Date()) {
  const at = now.toISOString();
  const row = await db.prepare(`SELECT y.id,y.connected_account,y.amount,c.customer_id FROM booking_monthly_cycles y
    JOIN booking_monthly_contracts c ON c.id=y.contract_id
    WHERE y.id=? AND y.state='planned' AND c.test_mode=1 AND c.customer_id IS NOT NULL`).bind(cycleId)
    .first<{id:string;connected_account:string;amount:number;customer_id:string}>();
  if (!row) return { status: 'unavailable' as const };
  const claim = await db.prepare("UPDATE booking_monthly_cycles SET state='preparing',version=version+1,updated_at=? WHERE id=? AND state='planned'")
    .bind(at, cycleId).run();
  if (claim.meta.changes !== 1) return { status: 'unavailable' as const };
  try {
    const invoice = await provider.create({ account: row.connected_account, customer: row.customer_id, amount: row.amount,
      currency: 'jpy', idempotencyKey: `monthly-invoice:${cycleId}` });
    if (!/^in_[A-Za-z0-9_]+$/.test(invoice.id) || invoice.livemode !== false || invoice.autoAdvance !== false
      || !['draft', 'open'].includes(invoice.status)) throw new Error('invalid_invoice');
    const result = await db.prepare("UPDATE booking_monthly_cycles SET invoice_id=?,invoice_status=?,auto_advance=0,state='open',version=version+1,updated_at=? WHERE id=? AND state='preparing'")
      .bind(invoice.id, invoice.status, at, cycleId).run();
    if (result.meta.changes !== 1) throw new Error('invoice_state_changed');
    return { status: 'created' as const };
  } catch {
    await db.prepare("UPDATE booking_monthly_cycles SET state='unknown',version=version+1,updated_at=? WHERE id=? AND state='preparing'")
      .bind(at, cycleId).run();
    return { status: 'unknown' as const };
  }
}
