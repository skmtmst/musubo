import { NotificationDeliveryIncomplete, sendRecordedNotification } from '../../services/recorded-notification-send.js';

export type LiveIntent = {
 id: string; accountId: string; kind: 'cart' | 'browse' | 'restock';
 occurrenceKey: string; friendId: string; productId: string; dueAt: string; payload: string;
};

/** One source occurrence per recipient. Duplicate events never replace the original payload. */
export async function scheduleLiveIntent(db: D1Database, intent: LiveIntent, now = new Date()): Promise<boolean> {
 const at = now.toISOString();
 const result = await db.prepare(`INSERT INTO ec_auto_line_live_intents
  (id,account_id,kind,occurrence_key,friend_id,product_id,due_at,payload_json,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING`)
  .bind(intent.id,intent.accountId,intent.kind,intent.occurrenceKey,intent.friendId,intent.productId,intent.dueAt,intent.payload,at,at).run();
 return result.meta.changes === 1;
}

/** A claim is never reclaimed automatically: a crash after the request could have sent it. */
export async function sendLiveIntent(db: D1Database, intent: LiveIntent, send: (retryKey: string) => Promise<unknown>, now = new Date()): Promise<'sent'|'failed'|'unknown'|'unclaimed'> {
 const claimed = await db.prepare("UPDATE ec_auto_line_live_intents SET state='sending',updated_at=? WHERE id=? AND account_id=? AND kind=? AND occurrence_key=? AND friend_id=? AND product_id=? AND due_at=? AND payload_json=? AND state='scheduled' AND julianday(due_at)<=julianday(?)")
  .bind(now.toISOString(),intent.id,intent.accountId,intent.kind,intent.occurrenceKey,intent.friendId,intent.productId,intent.dueAt,intent.payload,now.toISOString()).run();
 if (claimed.meta.changes !== 1) return 'unclaimed';
 let state: 'sent'|'failed'|'unknown';
 try {
  await sendRecordedNotification(db,{sourceId:`ec-live:${intent.id}`,channel:'line',recipient:intent.friendId,lineAccountId:intent.accountId,payload:intent.payload,send});
  state = 'sent';
 } catch (error) {
  state = error instanceof NotificationDeliveryIncomplete ? error.deliveryStatus : 'unknown';
 }
 await db.prepare("UPDATE ec_auto_line_live_intents SET state=?,updated_at=? WHERE id=? AND state='sending'")
  .bind(state,new Date().toISOString(),intent.id).run();
 return state;
}
