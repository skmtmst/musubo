/** These statements run in the same D1 batch as the source event insert. */
export function prepareLiveEventPlan(db:D1Database,eventId:string):D1PreparedStatement[]{
 return [
  db.prepare(`INSERT INTO ec_auto_line_live_intents(id,account_id,kind,occurrence_key,friend_id,product_id,due_at,original_due_at,payload_json,created_at,updated_at)
   SELECT lower(hex(randomblob(16))),e.account_id,r.kind,e.id,e.friend_id,e.product_id,
    strftime('%Y-%m-%dT%H:%M:%fZ',e.occurred_at,printf('+%d minutes',r.wait_minutes)),strftime('%Y-%m-%dT%H:%M:%fZ',e.occurred_at,printf('+%d minutes',r.wait_minutes)),r.messages_json,e.received_at,e.received_at
   FROM ec_behavior_events e JOIN ec_auto_line_rules r ON r.account_id=e.account_id AND r.enabled=1 AND r.kind=CASE e.type WHEN 'cart_add' THEN 'cart' ELSE 'browse' END
   JOIN friends f ON f.id=e.friend_id AND f.line_account_id=e.account_id
   WHERE e.id=? AND e.type IN('cart_add','product_view') AND julianday(e.occurred_at) IS NOT NULL
    AND (r.kind!='browse' OR (SELECT count(*) FROM ec_behavior_events v WHERE v.account_id=e.account_id AND v.friend_id=e.friend_id AND v.product_id=e.product_id AND v.type='product_view' AND julianday(v.occurred_at)>=julianday(e.occurred_at,'-24 hours'))>=2)
   ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING`).bind(eventId),
  db.prepare(`INSERT INTO ec_restock_occurrences(id,account_id,product_id,source_event_id,occurred_at)
   SELECT lower(hex(randomblob(16))),e.account_id,e.product_id,e.id,e.occurred_at FROM ec_behavior_events e
   WHERE e.id=? AND e.type='restock' AND json_extract(e.product_snapshot_json,'$.stock')>0 AND julianday(e.occurred_at) IS NOT NULL
   ON CONFLICT(account_id,source_event_id) DO NOTHING`).bind(eventId),
  db.prepare(`INSERT INTO ec_auto_line_live_intents(id,account_id,kind,occurrence_key,friend_id,product_id,due_at,original_due_at,payload_json,created_at,updated_at)
   SELECT lower(hex(randomblob(16))),e.account_id,'restock',e.id,s.friend_id,e.product_id,e.occurred_at,e.occurred_at,r.messages_json,e.received_at,e.received_at
   FROM ec_behavior_events e JOIN ec_auto_line_rules r ON r.account_id=e.account_id AND r.kind='restock' AND r.enabled=1
   JOIN ec_behavior_events s ON s.account_id=e.account_id AND s.product_id=e.product_id AND s.type='restock_subscribe' AND s.friend_id IS NOT NULL AND julianday(s.occurred_at)<julianday(e.occurred_at)
   JOIN friends f ON f.id=s.friend_id AND f.line_account_id=e.account_id
   WHERE e.id=? AND e.type='restock' AND json_extract(e.product_snapshot_json,'$.stock')>0 AND julianday(e.occurred_at) IS NOT NULL
   ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING`).bind(eventId),
 ];
}
