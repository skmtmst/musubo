/** 個人情報を残さない送信取消の印。期限は、結果不明でも本文を残し続けないための上限。 */
export const CUSTOMER_WORKFLOW_WAIT_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 友だち ID とアカウントを確実に結べる工程だけを選ぶ。名前や電話番号は照合しない。
 * ?1: friend ID, ?2: LINE user ID, ?3: account ID
 */
export const customerWorkflowCondition = `EXISTS (
  SELECT 1 FROM friends owner WHERE owner.id=?1 AND owner.line_account_id=?3
    AND owner.line_user_id IS ?2 AND ?3 IS NOT NULL
) AND (
  (workflow_steps.scope_id='friend:' || ?1 AND workflow_steps.process_kind='form_destinations')
  OR (workflow_steps.scope_id='line:' || ?3 AND (
    EXISTS (SELECT 1 FROM workflow_steps root
      WHERE root.scope_id=workflow_steps.scope_id AND root.process_kind=workflow_steps.process_kind
        AND root.subject_id=workflow_steps.subject_id AND root.step_key='__run'
        AND root.process_kind IN ('question_answer','tracked_click')
        AND json_extract(CASE WHEN json_valid(root.input_json) THEN root.input_json ELSE '{}' END,'$.friendId')=?1)
    OR (workflow_steps.process_kind='research_tap'
      AND json_extract(CASE WHEN json_valid(workflow_steps.subject_id) THEN workflow_steps.subject_id ELSE '[]' END,'$[2]')=?1)
    OR (workflow_steps.process_kind='meet_callback' AND workflow_steps.subject_id IN (
      SELECT json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END,'$.meet_hearing.session_id')
      FROM friends WHERE id=?1 AND line_account_id=?3))
    OR (workflow_steps.process_kind IN ('booking_calendar_create','booking_calendar_delete','booking_payment_start')
      AND workflow_steps.subject_id IN (SELECT id FROM bookings WHERE friend_id=?1 AND line_account_id=?3))
    OR (workflow_steps.process_kind='booking_late_payment' AND workflow_steps.subject_id IN (
      SELECT p.id FROM booking_payments p JOIN bookings b ON b.id=p.booking_id
      WHERE b.friend_id=?1 AND b.line_account_id=?3 AND p.line_account_id=?3))
    OR (workflow_steps.process_kind='booking_notification' AND workflow_steps.subject_id IN (
      SELECT r.id FROM booking_operation_runs r JOIN bookings b ON b.id=r.booking_id
      WHERE b.friend_id=?1 AND b.line_account_id=?3 AND r.line_account_id=?3))
    OR (workflow_steps.process_kind='booking_reminder' AND workflow_steps.subject_id IN (
      SELECT r.id FROM booking_reminders r JOIN bookings b ON b.id=r.booking_id WHERE b.friend_id=?1 AND b.line_account_id=?3))
    OR (workflow_steps.process_kind='event_reminder' AND workflow_steps.subject_id IN (
      SELECT r.id FROM event_booking_reminders r JOIN event_bookings b ON b.id=r.booking_id WHERE b.friend_id=?1 AND b.line_account_id=?3))
    OR (workflow_steps.process_kind='webinar_followup' AND (workflow_steps.subject_id IN (SELECT id FROM webinar_followups WHERE friend_id=?1)
      OR workflow_steps.subject_id IN (SELECT id FROM webinar_journey_followups WHERE friend_id=?1)))
    OR (?2 IS NOT NULL AND ?2<>'' AND workflow_steps.process_kind='booking_line_delivery'
      AND json_extract(CASE WHEN json_valid(workflow_steps.input_json) THEN workflow_steps.input_json ELSE '{}' END,'$.snapshot.to')=?2)
    OR (?2 IS NOT NULL AND ?2<>'' AND workflow_steps.process_kind='line_event'
      AND EXISTS (SELECT 1 FROM workflow_steps child WHERE child.scope_id=workflow_steps.scope_id
        AND child.process_kind=workflow_steps.process_kind AND child.subject_id=workflow_steps.subject_id
        AND json_extract(CASE WHEN json_valid(child.input_json) THEN child.input_json ELSE '{}' END,'$.to')=?2)
      AND NOT EXISTS (SELECT 1 FROM workflow_steps other WHERE other.scope_id=workflow_steps.scope_id
        AND other.process_kind=workflow_steps.process_kind AND other.subject_id=workflow_steps.subject_id
        AND json_extract(CASE WHEN json_valid(other.input_json) THEN other.input_json ELSE '{}' END,'$.to') IS NOT NULL
        AND json_extract(CASE WHEN json_valid(other.input_json) THEN other.input_json ELSE '{}' END,'$.to')<>?2))
  ))
)`;

/** 完了を確認できたものは消し、結果不明は受付から7日を上限に待つ。 */
export async function redactCustomerWorkflows(db:D1Database, now = Date.now()):Promise<number> {
  const result = await db.prepare(`UPDATE workflow_steps SET status='canceled', lease_owner=NULL, lease_expires_at=NULL,
      next_attempt_at=NULL, error_code=CASE WHEN status IN ('running','unknown') THEN 'customer_deleted_unknown' ELSE 'customer_deleted' END,
      input_json='{"redacted":true}', result_json=json_object('redacted',json('true'),'previousStatus',status,
        'requestId',CASE WHEN json_valid(result_json) THEN CASE WHEN json_type(result_json,'$.requestId')='text'
          AND length(json_extract(result_json,'$.requestId')) BETWEEN 1 AND 128
          AND json_extract(result_json,'$.requestId') NOT GLOB '*[^A-Za-z0-9_-]*'
          THEN json_extract(result_json,'$.requestId') ELSE NULL END ELSE NULL END), updated_at=?
    WHERE rowid IN (SELECT rowid FROM workflow_steps WHERE customer_redaction_requested_at IS NOT NULL
      AND COALESCE(error_code,'') NOT IN ('customer_deleted','customer_deleted_unknown')
      AND (status NOT IN ('running','unknown') OR customer_redaction_requested_at<=?)
      AND (status<>'running' OR lease_expires_at<=?) ORDER BY customer_redaction_requested_at LIMIT 100)`)
    .bind(now,now-CUSTOMER_WORKFLOW_WAIT_MS,now).run();
  // 結果待ちの工程が残る間は宛先照合を維持し、完了から7日と通常の借受時間後に消す。
  await db.prepare(`UPDATE operation_audit SET detail_json=json_remove(detail_json,'$.recipientDigest') WHERE rowid IN (
    SELECT audit.rowid FROM operation_audit audit WHERE audit.target_kind='customer_deletion' AND audit.action='deleted'
      AND json_valid(audit.detail_json) AND json_extract(audit.detail_json,'$.recipientDigest') IS NOT NULL
      AND CAST(strftime('%s',json_extract(audit.detail_json,'$.completedAt')) AS INTEGER)*1000<=?
      AND NOT EXISTS (SELECT 1 FROM workflow_steps w WHERE w.customer_redaction_requested_at IS NOT NULL
        AND COALESCE(w.error_code,'') NOT IN ('customer_deleted','customer_deleted_unknown')
        AND (w.scope_id='friend:' || audit.friend_id OR w.scope_id='line:' || json_extract(audit.detail_json,'$.accountId')))
    LIMIT 100)`).bind(now-CUSTOMER_WORKFLOW_WAIT_MS-300_000).run();
  return result.meta.changes;
}
