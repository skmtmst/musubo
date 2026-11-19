import { createBroadcastRetryKey } from '../broadcasts/broadcast-retry-key/index.js';
import { NotificationDeliveryIncomplete, sendRecordedNotification } from '../../services/recorded-notification-send.js';

export type LiveIntent = {
 id: string; accountId: string; kind: 'cart' | 'browse' | 'restock';
 occurrenceKey: string; friendId: string; productId: string; dueAt: string; payload: string;
};

/** One source occurrence per recipient. Duplicate events never replace the original payload. */
export async function scheduleLiveIntent(db: D1Database, intent: LiveIntent, now = new Date()): Promise<boolean> {
 const at = now.toISOString();
 const result = await db.prepare(`INSERT INTO ec_auto_line_live_intents
  (id,account_id,kind,occurrence_key,friend_id,product_id,due_at,original_due_at,payload_json,created_at,updated_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,kind,occurrence_key,friend_id) DO NOTHING`)
  .bind(intent.id,intent.accountId,intent.kind,intent.occurrenceKey,intent.friendId,intent.productId,intent.dueAt,intent.dueAt,intent.payload,at,at).run();
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
  // An HTTP timeout or server error cannot prove that LINE did not accept the request.
  if(state==='failed' && error instanceof NotificationDeliveryIncomplete && !error.blockedReason){
   const key=await createBroadcastRetryKey('notification',`ec-live:${intent.id}`,'line',intent.friendId);
   const record=await db.prepare('SELECT failure_code FROM outbound_send_requests WHERE idempotency_key=?').bind(key).first<{failure_code:string|null}>();
   if(!record || !['LINE_RATE_LIMITED','LINE_REQUEST_REJECTED'].includes(record.failure_code??'')){
    state='unknown';
    // The shared ledger must not leave an ambiguous request eligible for a retry.
    await db.prepare("UPDATE outbound_send_requests SET status='unknown',retryable=0,next_retry_at=NULL WHERE idempotency_key=? AND status='failed' AND failure_code='LINE_TEMPORARILY_UNAVAILABLE'").bind(key).run();
   }
  }
 }
 const saved=await db.prepare("UPDATE ec_auto_line_live_intents SET state=?,updated_at=? WHERE id=? AND state='sending'")
  .bind(state,new Date().toISOString(),intent.id).run();
 if(saved.meta.changes!==1)throw new Error('ec_live_intent_completion_not_saved');
 return state;
}

/** Restore only a confirmed acceptance; an unfinished request is never resent automatically. */
export async function reconcileLiveIntent(db: D1Database, id: string, now = new Date()): Promise<boolean> {
 const intent = await db.prepare("SELECT friend_id FROM ec_auto_line_live_intents WHERE id=? AND state='sending'").bind(id).first<{friend_id:string}>();
 if (!intent) return false;
 const key = await createBroadcastRetryKey('notification',`ec-live:${id}`,'line',intent.friend_id);
 const result = await db.prepare(`UPDATE ec_auto_line_live_intents SET state='sent',updated_at=?
  WHERE id=? AND friend_id=? AND state='sending' AND EXISTS (
   SELECT 1 FROM outbound_send_requests o WHERE o.idempotency_key=? AND o.resource_id='ec-live:'||ec_auto_line_live_intents.id
    AND o.channel='line' AND o.line_account_id=ec_auto_line_live_intents.account_id AND o.status='succeeded'
  )`).bind(now.toISOString(),id,intent.friend_id,key).run();
 return result.meta.changes === 1;
}
