import { applyCardCheckoutReceipt } from './card-checkout.js';
import { applyCardSetupReceipt } from './card-setup.js';

/** 保存済みの関連がある保留だけを再処理する。外部通信はしない。 */
export async function recoverCardSetupReceipts(db:D1Database):Promise<{failed:number}> {
  const rows=await db.prepare(`SELECT w.subject_id event_id,json_extract(w.input_json,'$.event.account') account,
    json_extract(w.input_json,'$.event.type') event_type,json_extract(b.input_json,'$.targetId') request_id
    FROM workflow_steps w JOIN workflow_steps b ON b.scope_id=w.scope_id
      AND b.process_kind='booking_stripe_object' AND b.step_key='binding'
      AND b.subject_id=json_extract(w.input_json,'$.event.object.id')
    JOIN booking_card_checkout_requests r ON r.id=json_extract(b.input_json,'$.targetId') AND r.connect_account=json_extract(w.input_json,'$.event.account')
    WHERE w.scope_id>='stripe-test:' AND w.scope_id<'stripe-test;' AND w.process_kind='booking_stripe_webhook'
      AND w.step_key='apply' AND w.status IN ('pending','running') AND (w.error_code IS NULL OR w.error_code='stripe_binding_overdue')
      AND json_extract(w.input_json,'$.event.type') IN ('checkout.session.completed','setup_intent.succeeded')
    ORDER BY w.created_at LIMIT 50`).all<{event_id:string;account:string;event_type:string;request_id:string}>();
  let failed=0;
  for (const row of rows.results) {
    try {
      if (row.event_type==='checkout.session.completed') await applyCardCheckoutReceipt(db,row.account,row.event_id);
      else await applyCardSetupReceipt(db,row.account,row.event_id,row.request_id);
    } catch {
      failed++;
      // 直せない受信が先頭を埋めないよう、要確認にして他の受信を進める。
      await db.prepare(`UPDATE workflow_steps SET error_code='stripe_card_recovery_failed',updated_at=?
        WHERE scope_id=? AND process_kind='booking_stripe_webhook' AND subject_id=? AND step_key='apply' AND status='pending'`)
        .bind(Date.now(),`stripe-test:${row.account}`,row.event_id).run();
    }
  }
  return {failed};
}
