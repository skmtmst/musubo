/** 親の無い旧注文明細だけを有限件ずつ削除し、件数のみを同じ batch で監査する。 */
export async function cleanupDeliveryOrphans(db: D1Database): Promise<number> {
  const id = crypto.randomUUID();
  const result = await db.batch([
    db.prepare(`DELETE FROM rt_delivery_order_items WHERE rowid IN (
      SELECT i.rowid FROM rt_delivery_order_items i
      WHERE NOT EXISTS (SELECT 1 FROM rt_delivery_orders o WHERE o.id = i.order_id)
      ORDER BY i.rowid LIMIT 500
    )`).bind(),
    db.prepare(`INSERT INTO audit_events(id,tenant_id,category,actor_principal_id,action,target_kind,result,after_json,retention_class)
      SELECT ?, 'default', 'business', 'system:retention', 'privacy.delivery_orphans.cleaned', 'delivery_orphans',
        'success', json_object('deletedRows',changes()), 'security' WHERE changes() > 0`).bind(id),
  ]);
  return Number(result[0].meta.changes ?? 0);
}
